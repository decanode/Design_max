-- AI Project Planning module: per-project feature flags, the project charter, and the work breakdown structure.

ALTER TABLE projects ADD COLUMN enabled_modules JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(enabled_modules) = 'object');

-- One live charter per project. Sections are kept as Markdown text (what the AI writes and what is searchable);
-- content_json is the rich-text document people edit, ydoc its live co-editing state.
CREATE TABLE project_charters (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  executive_summary  TEXT NOT NULL DEFAULT '',
  objectives         TEXT NOT NULL DEFAULT '',
  scope              TEXT NOT NULL DEFAULT '',
  out_of_scope       TEXT NOT NULL DEFAULT '',
  stakeholders       TEXT NOT NULL DEFAULT '',
  milestones         TEXT NOT NULL DEFAULT '',
  risks              TEXT NOT NULL DEFAULT '',
  content_json       JSONB,
  ydoc               BYTEA,
  intake             JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Approved')),
  generated_by       TEXT,                       -- e.g. "gemini-2.5-flash" or "offline template"
  created_by         UUID REFERENCES users(id),
  approved_by        UUID REFERENCES users(id),
  approved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The WBS: a three-level tree (Phase -> Deliverable -> Work Package) in one self-referencing table.
CREATE TABLE wbs_elements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id        UUID REFERENCES wbs_elements(id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description      TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  estimated_effort NUMERIC(8,1) CHECK (estimated_effort IS NULL OR estimated_effort >= 0),     -- person-days; only meaningful on work packages
  order_index      INT NOT NULL DEFAULT 0,
  level            INT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('ai','manual')),
  ticket_id        UUID REFERENCES tickets(id) ON DELETE SET NULL,                              -- set when a work package becomes a ticket
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wbs_elements_tree ON wbs_elements (project_id, parent_id, order_index);

-- Structure rules in the database: same project, three levels at most, no cycles, and only work packages become tickets.
CREATE FUNCTION wbs_guard() RETURNS trigger AS $$
DECLARE parent_level INT; height INT;
BEGIN
  IF NEW.parent_id IS NULL THEN NEW.level := 1;
  ELSE
    SELECT level INTO parent_level FROM wbs_elements WHERE id = NEW.parent_id AND project_id = NEW.project_id;
    IF parent_level IS NULL THEN RAISE EXCEPTION 'The parent must be an element of the same project' USING ERRCODE = 'check_violation'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.parent_id = NEW.id OR EXISTS (
        WITH RECURSIVE d AS (SELECT id FROM wbs_elements WHERE parent_id = NEW.id UNION SELECT e.id FROM wbs_elements e JOIN d ON e.parent_id = d.id)
        SELECT 1 FROM d WHERE id = NEW.parent_id)) THEN
      RAISE EXCEPTION 'An element cannot be moved under itself' USING ERRCODE = 'check_violation';
    END IF;
    NEW.level := parent_level + 1;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE s(id, lvl) AS (SELECT NEW.id, 0 UNION ALL SELECT e.id, s.lvl + 1 FROM wbs_elements e JOIN s ON e.parent_id = s.id)
    SELECT max(lvl) INTO height FROM s;
  ELSE height := 0; END IF;
  IF NEW.level + coalesce(height, 0) > 3 THEN RAISE EXCEPTION 'A WBS has three levels: phases, deliverables and work packages' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.ticket_id IS NOT NULL AND NEW.level <> 3 THEN RAISE EXCEPTION 'Only work packages can become tickets' USING ERRCODE = 'check_violation'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER wbs_elements_guard BEFORE INSERT OR UPDATE ON wbs_elements FOR EACH ROW EXECUTE FUNCTION wbs_guard();

-- Children's levels follow when a subtree moves.
CREATE FUNCTION wbs_relevel() RETURNS trigger AS $$
BEGIN
  IF NEW.level IS DISTINCT FROM OLD.level THEN
    UPDATE wbs_elements SET level = NEW.level + 1 WHERE parent_id = NEW.id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER wbs_elements_relevel AFTER UPDATE OF level ON wbs_elements FOR EACH ROW EXECUTE FUNCTION wbs_relevel();

ALTER TABLE project_charters ENABLE ROW LEVEL SECURITY;
ALTER TABLE wbs_elements ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON project_charters USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
CREATE POLICY project_isolation ON wbs_elements USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_charters, wbs_elements TO design_max_app;

-- The Project Manager role: runs the plan and the team's tickets, without administering the project.
INSERT INTO roles (name, description, is_system)
VALUES ('Project Manager', 'Plans the project: charter, work breakdown and the tickets that come from it, and follows the team.', true);
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p FROM roles r, (VALUES ('board.view'), ('ticket.view_all'), ('ticket.create'), ('ticket.claim'), ('ticket.assign'), ('ticket.advance'), ('spec.view'), ('doc.comment'),
  ('dashboard.team'), ('dashboard.portfolio'), ('report.view'), ('report.build'), ('planning.manage')) AS d(p) WHERE r.name = 'Project Manager';
-- the Project Manager sees the same ticket fields as a Lead
INSERT INTO ticket_field_access (role_id, field, access)
SELECT (SELECT id FROM roles WHERE name = 'Project Manager'), field, access FROM ticket_field_access WHERE role_id = (SELECT id FROM roles WHERE name = 'Lead');
