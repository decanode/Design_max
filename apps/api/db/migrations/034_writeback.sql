-- Sending agreed outcomes back to the source tool (Connected projects only). Rules say what, the queue is the safe, retryable way it is sent.
CREATE TABLE writeback_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('phase_entered','document_approved','signoff_approved','ticket_closed')),
  action TEXT NOT NULL CHECK (action IN ('status','comment','attach')), params JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  enabled BOOLEAN NOT NULL DEFAULT true, position INT NOT NULL DEFAULT 0);
CREATE INDEX writeback_rules_conn ON writeback_rules (connection_id, position);

-- Written in the same transaction as the event that caused it, so a change here and its send can never disagree.
CREATE TABLE outbound_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, rule_id UUID REFERENCES writeback_rules(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('status','comment','attach')), payload JSONB NOT NULL DEFAULT '{}', actor_id UUID REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped','cancelled')),
  dry_run BOOLEAN NOT NULL DEFAULT false, attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT, result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ);
CREATE INDEX outbound_queue_due ON outbound_queue (status, next_attempt_at);
CREATE INDEX outbound_queue_ticket ON outbound_queue (ticket_id, created_at DESC);

-- "Do not send anything about this ticket" (an admin's per-ticket switch).
ALTER TABLE tickets ADD COLUMN writeback_paused BOOLEAN NOT NULL DEFAULT false;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['writeback_rules','outbound_queue'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY project_isolation ON %I USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO design_max_app', t);
  END LOOP;
END $$;
