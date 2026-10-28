-- Richer people records (in the spirit of Jira and ServiceNow user profiles), project teams, and team-based ticket access.

ALTER TABLE users
  ADD COLUMN first_name  TEXT, ADD COLUMN last_name TEXT,
  ADD COLUMN user_id     TEXT,                      -- the sign-in / directory ID, unique on the platform
  ADD COLUMN employee_id TEXT, ADD COLUMN phone TEXT, ADD COLUMN mobile TEXT,
  ADD COLUMN job_title   TEXT, ADD COLUMN department TEXT, ADD COLUMN company TEXT, ADD COLUMN location TEXT, ADD COLUMN cost_center TEXT,
  ADD COLUMN manager_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN time_zone   TEXT, ADD COLUMN language TEXT, ADD COLUMN notes TEXT;

-- Existing people: split the display name, and derive a unique user ID from the email address.
UPDATE users SET first_name = split_part(display_name, ' ', 1), last_name = nullif(btrim(substr(display_name, length(split_part(display_name, ' ', 1)) + 1)), '');
WITH base AS (SELECT id, regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]+', '.', 'g') AS b FROM users),
     n AS (SELECT id, CASE WHEN length(b) < 3 THEN b || '.usr' ELSE b END AS b, row_number() OVER (PARTITION BY b ORDER BY id) AS rn FROM base)
UPDATE users u SET user_id = CASE WHEN n.rn = 1 THEN n.b ELSE n.b || n.rn END FROM n WHERE n.id = u.id;
CREATE UNIQUE INDEX users_user_id_uq ON users (lower(user_id));

-- New accounts (from any path: invitations, demo data, bootstrap) get the same defaults.
CREATE FUNCTION users_defaults() RETURNS trigger AS $$
DECLARE base TEXT; cand TEXT; i INT := 1;
BEGIN
  IF NEW.first_name IS NULL AND NEW.display_name IS NOT NULL THEN
    NEW.first_name := split_part(NEW.display_name, ' ', 1);
    NEW.last_name := nullif(btrim(substr(NEW.display_name, length(split_part(NEW.display_name, ' ', 1)) + 1)), '');
  END IF;
  IF NEW.user_id IS NULL THEN
    base := regexp_replace(lower(split_part(NEW.email, '@', 1)), '[^a-z0-9._-]+', '.', 'g');
    IF length(base) < 3 THEN base := base || '.usr'; END IF;
    cand := base;
    WHILE EXISTS (SELECT 1 FROM users WHERE lower(user_id) = cand) LOOP i := i + 1; cand := base || i; END LOOP;
    NEW.user_id := cand;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_defaults BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_defaults();

-- Teams belong to one project; a person can be in several.
CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  lead_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_uq ON teams (project_id, lower(name));
CREATE TABLE team_members (
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id, project_id);
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON teams USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
CREATE POLICY project_isolation ON team_members USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO design_max_app;

-- Leaving the project means leaving its teams.
CREATE FUNCTION member_left_project() RETURNS trigger AS $$
BEGIN
  DELETE FROM team_members WHERE project_id = OLD.project_id AND user_id = OLD.user_id;
  UPDATE teams SET lead_id = NULL WHERE project_id = OLD.project_id AND lead_id = OLD.user_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER project_members_left AFTER DELETE ON project_members FOR EACH ROW EXECUTE FUNCTION member_left_project();

-- A ticket can be assigned to a team of its own project.
ALTER TABLE tickets ADD COLUMN team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX tickets_team_idx ON tickets (project_id, team_id);
CREATE FUNCTION ticket_team_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams WHERE id = NEW.team_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'The team belongs to another project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tickets_team_guard BEFORE INSERT OR UPDATE OF team_id ON tickets FOR EACH ROW EXECUTE FUNCTION ticket_team_guard();

-- Team members can see (and, within their role's field access, work on) the tickets assigned to their teams.
INSERT INTO role_permissions (role_id, permission) SELECT id, 'ticket.team_access' FROM roles WHERE name IN ('Consultant', 'Lead', 'Project Manager');
