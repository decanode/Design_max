-- Source-system connections (Jira, ServiceNow), the sync that pulls tickets in, and what we remember about where each ticket came from.

CREATE TABLE integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('jira','servicenow')),
  name TEXT NOT NULL, base_url TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
  secret_enc TEXT,                                   -- AES-256-GCM; never returned by any route
  config JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  enabled BOOLEAN NOT NULL DEFAULT true, sync_interval_min INT NOT NULL DEFAULT 15 CHECK (sync_interval_min BETWEEN 1 AND 1440),
  cursor JSONB NOT NULL DEFAULT '{}', last_sync_at TIMESTAMPTZ, health TEXT NOT NULL DEFAULT 'new' CHECK (health IN ('new','ok','error')),
  writeback_enabled BOOLEAN NOT NULL DEFAULT false, dry_run BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name));

ALTER TABLE tickets ADD COLUMN connection_id UUID REFERENCES integration_connections(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN source_url TEXT;
ALTER TABLE tickets ADD COLUMN source_status TEXT;
ALTER TABLE tickets ADD COLUMN source_updated_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN source_hash TEXT;
ALTER TABLE tickets ADD COLUMN source_removed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN out_of_sync BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX tickets_connection_idx ON tickets (connection_id) WHERE connection_id IS NOT NULL;

-- What the source tool said about each ticket's status over time, kept apart from our own phases.
CREATE TABLE ticket_source_history (
  id BIGSERIAL PRIMARY KEY, ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor TEXT);
CREATE INDEX ticket_source_history_ticket ON ticket_source_history (ticket_id, at);

-- How a source status maps onto one of the project's own phases (used when a ticket first arrives).
CREATE TABLE status_maps (
  connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_status TEXT NOT NULL, phase_id INT NOT NULL REFERENCES phases(id), PRIMARY KEY (connection_id, source_status));

CREATE TABLE sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual','webhook')), full_scan BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')), started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  created INT NOT NULL DEFAULT 0, updated INT NOT NULL DEFAULT 0, unchanged INT NOT NULL DEFAULT 0, failed INT NOT NULL DEFAULT 0, removed INT NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX sync_runs_conn ON sync_runs (connection_id, started_at DESC);
CREATE TABLE sync_failures (
  id BIGSERIAL PRIMARY KEY, run_id UUID NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_key TEXT, error TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections','ticket_source_history','status_maps','sync_runs','sync_failures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY project_isolation ON %I USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO design_max_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO design_max_app;
