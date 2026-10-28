-- Roles that belong to one project, and a per-person switch (set by a Super Admin) that lets a Project Admin create them.
ALTER TABLE roles ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;       -- NULL = a standard role every project sees
ALTER TABLE roles DROP CONSTRAINT roles_name_key;
CREATE UNIQUE INDEX roles_standard_name_uq ON roles (lower(name)) WHERE project_id IS NULL;
CREATE UNIQUE INDEX roles_project_name_uq ON roles (project_id, lower(name)) WHERE project_id IS NOT NULL;
ALTER TABLE project_members ADD COLUMN can_create_roles BOOLEAN NOT NULL DEFAULT false;
