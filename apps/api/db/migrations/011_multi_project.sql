-- Multi-project workspaces with delegated administration.
--   Super Admin  : platform-wide (creates projects and users, appoints Project Admins, owns the role/stack catalogs).
--   Project Admin: runs ONE project (members, role tuning, workflows, technology, field access, reports).
-- A person's role now belongs to a (project, user) membership, not to the user.

ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL;      -- a person's role now lives on their project membership
ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false;
UPDATE users SET is_super_admin = true WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin');

INSERT INTO roles (name, description, is_system)
VALUES ('Project Admin', 'Runs one project: members and their roles, role tuning, approval workflows, technology and ticket fields.', true);

ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'));
ALTER TABLE projects ADD COLUMN created_by UUID REFERENCES users(id);

CREATE TABLE project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  role_id    INT  NOT NULL REFERENCES roles(id),
  added_by   UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);

-- Status quo: everyone keeps their current role in every existing project.
INSERT INTO project_members (project_id, user_id, role_id)
SELECT p.id, u.id, u.role_id FROM projects p CROSS JOIN users u
WHERE NOT u.is_super_admin AND u.role_id IS NOT NULL;

-- Per-project tuning of what a role can do (layered over the role's standard template).
CREATE TABLE project_role_overrides (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_id    INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  perms      BOOLEAN NOT NULL DEFAULT false,
  fields     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, role_id)
);
CREATE TABLE project_role_permissions (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_id    INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (project_id, role_id, permission)
);
CREATE TABLE project_ticket_field_access (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_id    INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  access     TEXT NOT NULL CHECK (access IN ('hidden','read','write')),
  PRIMARY KEY (project_id, role_id, field)
);

-- Reports and dashboards: custom ones belong to a project; built-ins (is_system) stay shared templates.
ALTER TABLE reports    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE dashboards ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
UPDATE reports    SET project_id = (SELECT id FROM projects ORDER BY created_at LIMIT 1) WHERE NOT is_system;
UPDATE dashboards SET project_id = (SELECT id FROM projects ORDER BY created_at LIMIT 1) WHERE NOT is_system;

-- Imported legacy keys only need to be unique inside one project (two projects may both import a Jira "PROJ-1").
DROP INDEX tickets_legacy_id_uq;
CREATE UNIQUE INDEX tickets_legacy_id_uq ON tickets (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
ALTER TABLE ticket_comments DROP CONSTRAINT ticket_comments_legacy_id_key;
ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_legacy_uq UNIQUE (ticket_id, legacy_id);
ALTER TABLE attachments DROP CONSTRAINT attachments_legacy_id_key;
ALTER TABLE attachments ADD CONSTRAINT attachments_legacy_uq UNIQUE (ticket_id, legacy_id);

-- Knowledge and audit trail carry their project (NULL embeddings = shared platform knowledge).
ALTER TABLE embeddings ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE embeddings DROP CONSTRAINT embeddings_source_uq;
CREATE UNIQUE INDEX embeddings_source_uq ON embeddings (source_type, source_ref, (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)));
ALTER TABLE audit_log  ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX audit_log_project_idx ON audit_log(project_id);

-- Approval workflows belong to a project. The old "all projects" rows become templates copied into new projects,
-- and every existing project gets a copy for the document types it does not already have its own workflow for.
ALTER TABLE approval_workflows ADD COLUMN is_template BOOLEAN NOT NULL DEFAULT false;
UPDATE approval_workflows SET is_template = true WHERE project_id IS NULL;

DO $$
DECLARE p RECORD; w RECORD; kinds TEXT[]; nw UUID; l RECORD; nl UUID;
BEGIN
  FOR p IN SELECT id FROM projects LOOP
    FOR w IN SELECT * FROM approval_workflows WHERE is_template AND active LOOP
      SELECT COALESCE(array_agg(k), '{}') INTO kinds FROM unnest(w.kinds) k
        WHERE NOT EXISTS (SELECT 1 FROM approval_workflows x WHERE x.project_id = p.id AND x.active AND k = ANY(x.kinds));
      CONTINUE WHEN cardinality(kinds) = 0;
      INSERT INTO approval_workflows (name, description, kinds, project_id, active, is_system)
        VALUES (w.name, w.description, kinds, p.id, true, false) RETURNING id INTO nw;
      FOR l IN SELECT * FROM approval_levels WHERE workflow_id = w.id LOOP
        INSERT INTO approval_levels (workflow_id, position, name, rule) VALUES (nw, l.position, l.name, l.rule) RETURNING id INTO nl;
        INSERT INTO approval_level_approvers (level_id, kind, user_id, role_id)
          SELECT nl, kind, user_id, role_id FROM approval_level_approvers WHERE level_id = l.id;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- The old global "Admin" role is replaced by the Super Admin flag; nobody's access changes (they were made Super Admins above).
UPDATE users SET role_id = NULL WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin');
DELETE FROM approval_level_approvers WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin');
DELETE FROM roles WHERE name = 'Admin';
