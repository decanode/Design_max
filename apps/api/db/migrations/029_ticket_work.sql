-- Ticket work: readable keys, priority and due date, which documents each ticket type needs, a conversation per ticket,
-- and the customer's sign-off before a ticket they raised can be closed.

ALTER TABLE tickets ADD COLUMN seq INT;
ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low','Medium','High','Critical'));
ALTER TABLE tickets ADD COLUMN due_date DATE;

CREATE TABLE project_ticket_counters (project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, last INT NOT NULL DEFAULT 0);
ALTER TABLE project_ticket_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON project_ticket_counters USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
WITH n AS (SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn FROM tickets) UPDATE tickets t SET seq = n.rn FROM n WHERE n.id = t.id;
INSERT INTO project_ticket_counters (project_id, last) SELECT project_id, max(seq) FROM tickets GROUP BY project_id;
CREATE UNIQUE INDEX tickets_seq_uq ON tickets (project_id, seq);
CREATE FUNCTION ticket_seq() RETURNS trigger AS $$
BEGIN
  IF NEW.seq IS NULL THEN
    INSERT INTO project_ticket_counters (project_id, last) VALUES (NEW.project_id, 1)
      ON CONFLICT (project_id) DO UPDATE SET last = project_ticket_counters.last + 1 RETURNING last INTO NEW.seq;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tickets_seq BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION ticket_seq();

-- Which documents a kind of ticket uses. No row = optional (the behaviour before this table existed).
CREATE TABLE ticket_type_documents (
  ticket_type_id INT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('FS','TS','TUT','CRC')),
  mode TEXT NOT NULL CHECK (mode IN ('off','optional','required')),
  PRIMARY KEY (ticket_type_id, kind));
INSERT INTO ticket_type_documents (ticket_type_id, kind, mode)
SELECT t.id, k, m FROM ticket_types t JOIN (VALUES
  ('incident','FS','off'),('incident','TS','off'),('incident','TUT','required'),('incident','CRC','off'),
  ('change','FS','required'),('change','TS','required'),('change','TUT','required'),('change','CRC','required'),
  ('problem','FS','off'),('problem','TS','off'),('problem','TUT','optional'),('problem','CRC','off'),
  ('ritm','FS','off'),('ritm','TS','off'),('ritm','TUT','off'),('ritm','CRC','off')
) v(key, k, m) ON v.key = t.key;

-- The conversation on a ticket (ticket_comments holds comments imported from Jira / ServiceNow). Internal notes are for the team only.
CREATE TABLE ticket_notes (
  id BIGSERIAL PRIMARY KEY, ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id), body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000), internal BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX ticket_notes_ticket ON ticket_notes (ticket_id, id);

-- The customer who raised a ticket confirms it is resolved before it can be closed.
CREATE TABLE ticket_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by UUID REFERENCES users(id), requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ, comment TEXT);
CREATE UNIQUE INDEX ticket_signoffs_one_pending ON ticket_signoffs (ticket_id) WHERE status = 'pending';
CREATE INDEX ticket_signoffs_ticket ON ticket_signoffs (ticket_id, requested_at);

ALTER TABLE ticket_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE ticket_signoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON ticket_notes USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
CREATE POLICY project_isolation ON ticket_signoffs USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_ticket_counters, ticket_type_documents, ticket_notes, ticket_signoffs TO design_max_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO design_max_app;
