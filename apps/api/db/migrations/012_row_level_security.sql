-- Database-enforced project isolation (second layer behind the application's own scoping).
-- The app connects as `design_max_app`, which cannot bypass row-level security. Each request/event tells the database
-- which project it works for (`app.project_id`) or that it is a platform operation (`app.platform = on`); with neither,
-- project tables show NOTHING. So even a query that forgets its WHERE clause cannot cross a project wall.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'design_max_app') THEN
    -- Development default. Production must set its own password: ALTER ROLE design_max_app PASSWORD '...'.
    CREATE ROLE design_max_app LOGIN PASSWORD 'design_max_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO design_max_app', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO design_max_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO design_max_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO design_max_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO design_max_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO design_max_app;
REVOKE ALL ON _migrations FROM design_max_app;                  -- the app can never rewrite its own schema history

CREATE FUNCTION app_project() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.project_id', true), '')::uuid $$;
CREATE FUNCTION app_platform() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.platform', true), '') = 'on' $$;

-- Tables that carry their own project_id: visible and writable only inside that project.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['tickets', 'conversations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY project_isolation ON %I USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project())', t);
  END LOOP;
END $$;

-- Approval workflows: a project's own; project-less rows are platform templates, invisible inside a project.
ALTER TABLE approval_workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON approval_workflows USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());

-- Shared-or-project tables: project-less rows (built-in reports/dashboards, shared knowledge) are readable by every project
-- but writable only by the platform; a project can only change its own rows.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['reports', 'dashboards', 'embeddings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_scope ON %I FOR SELECT USING (app_platform() OR project_id IS NULL OR project_id = app_project())', t);
    EXECUTE format('CREATE POLICY insert_scope ON %I FOR INSERT WITH CHECK (app_platform() OR project_id = app_project())', t);
    EXECUTE format('CREATE POLICY update_scope ON %I FOR UPDATE USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project())', t);
    EXECUTE format('CREATE POLICY delete_scope ON %I FOR DELETE USING (app_platform() OR project_id = app_project())', t);
  END LOOP;
END $$;

-- The audit trail is append-only for the app (no UPDATE/DELETE policy exists), and a project only sees its own entries.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_scope   ON audit_log FOR SELECT USING (app_platform() OR project_id = app_project());
CREATE POLICY insert_scope ON audit_log FOR INSERT WITH CHECK (app_platform() OR project_id = app_project());

-- Child tables inherit their parent's visibility (the parent's own policy applies inside the sub-select).
CREATE POLICY via_conversation ON messages            USING (EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id)) WITH CHECK (EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id));
CREATE POLICY via_conversation ON requirement_drafts  USING (EXISTS (SELECT 1 FROM conversations c WHERE c.id = requirement_drafts.conversation_id)) WITH CHECK (EXISTS (SELECT 1 FROM conversations c WHERE c.id = requirement_drafts.conversation_id));
CREATE POLICY via_ticket ON documents            USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = documents.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = documents.ticket_id));
CREATE POLICY via_ticket ON approvals            USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = approvals.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = approvals.ticket_id));
CREATE POLICY via_ticket ON approval_requests    USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = approval_requests.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = approval_requests.ticket_id));
CREATE POLICY via_ticket ON ticket_transitions   USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_transitions.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_transitions.ticket_id));
CREATE POLICY via_ticket ON ticket_comments      USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id));
CREATE POLICY via_ticket ON attachments          USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = attachments.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = attachments.ticket_id));
CREATE POLICY via_workflow ON approval_levels    USING (EXISTS (SELECT 1 FROM approval_workflows w WHERE w.id = approval_levels.workflow_id)) WITH CHECK (EXISTS (SELECT 1 FROM approval_workflows w WHERE w.id = approval_levels.workflow_id));
CREATE POLICY via_level ON approval_level_approvers USING (EXISTS (SELECT 1 FROM approval_levels l WHERE l.id = approval_level_approvers.level_id)) WITH CHECK (EXISTS (SELECT 1 FROM approval_levels l WHERE l.id = approval_level_approvers.level_id));
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_level_approvers ENABLE ROW LEVEL SECURITY;
