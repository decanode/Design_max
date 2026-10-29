-- Breaking a ticket down into the work it takes, inside Design Max. Works for any ticket, including ones mirrored from Jira / ServiceNow.
CREATE TABLE work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300), state TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','blocked','done')),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL, estimate_h NUMERIC(8,2) CHECK (estimate_h IS NULL OR estimate_h >= 0), actual_h NUMERIC(8,2) CHECK (actual_h IS NULL OR actual_h >= 0),
  position INT NOT NULL DEFAULT 0, depends_on UUID[] NOT NULL DEFAULT '{}', done_at TIMESTAMPTZ, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX work_items_ticket ON work_items (ticket_id, position);
-- The standard tasks a project adds to every ticket of a kind (for example: reproduce, fix, test, confirm).
CREATE TABLE work_item_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, ticket_type_id INT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300), estimate_h NUMERIC(8,2) CHECK (estimate_h IS NULL OR estimate_h >= 0), position INT NOT NULL DEFAULT 0);
CREATE INDEX work_item_templates_type ON work_item_templates (project_id, ticket_type_id, position);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['work_items','work_item_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY project_isolation ON %I USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO design_max_app', t);
  END LOOP;
END $$;
