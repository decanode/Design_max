-- Flow reporting: how long work really takes, where it waits, how often it bounces, and what the pipeline looked like on each day.
-- Views are security_invoker, so row-level security applies exactly as it does for the tables underneath.

-- Every stretch a ticket spent in one status: our own phases (from ticket_transitions) and the source tool's statuses (from ticket_source_history).
CREATE VIEW ticket_intervals_v WITH (security_invoker = true) AS
  SELECT x.ticket_id, t.project_id, 'phase'::text AS origin, x.to_state AS name, x.created_at AS entered_at,
         COALESCE(lead(x.created_at) OVER w, now()) AS left_at, (lead(x.created_at) OVER w IS NULL) AS is_open,
         row_number() OVER (PARTITION BY x.ticket_id, x.to_state ORDER BY x.created_at, x.id) AS visit_no
  FROM ticket_transitions x JOIN tickets t ON t.id = x.ticket_id
  WINDOW w AS (PARTITION BY x.ticket_id ORDER BY x.created_at, x.id)
  UNION ALL
  SELECT h.ticket_id, h.project_id, 'source', h.to_status, h.at, COALESCE(lead(h.at) OVER w, now()), (lead(h.at) OVER w IS NULL),
         row_number() OVER (PARTITION BY h.ticket_id, h.to_status ORDER BY h.at, h.id)
  FROM ticket_source_history h WINDOW w AS (PARTITION BY h.ticket_id ORDER BY h.at, h.id)
  UNION ALL   -- the status a mirrored ticket was in before the first change we know of
  SELECT f.ticket_id, f.project_id, 'source', f.from_status, t.created_at, f.at, false, 1
  FROM (SELECT DISTINCT ON (ticket_id) ticket_id, project_id, from_status, at FROM ticket_source_history ORDER BY ticket_id, at, id) f
  JOIN tickets t ON t.id = f.ticket_id WHERE f.from_status IS NOT NULL;

-- One row per finished ticket: when it started, when it finished (our own phases first, the source's statuses for mirrored tickets).
CREATE VIEW ticket_flow_v WITH (security_invoker = true) AS
  SELECT t.id AS ticket_id, t.project_id,
         COALESCE(ld.at, sd.at) AS done_at,
         COALESCE(ls.at, ss.at) AS started_at
  FROM tickets t
  LEFT JOIN LATERAL (SELECT min(x.created_at) AS at FROM ticket_transitions x JOIN phases p ON p.name = x.to_state AND p.tone = 'done' WHERE x.ticket_id = t.id) ld ON true
  LEFT JOIN LATERAL (SELECT min(h.at) AS at FROM ticket_source_history h WHERE h.ticket_id = t.id AND h.to_status ~* '(done|closed|resolved|complete|cancel|reject|fixed|released|deployed)') sd ON true
  LEFT JOIN LATERAL (SELECT min(x.created_at) AS at FROM ticket_transitions x WHERE x.ticket_id = t.id AND x.from_state IS NOT NULL) ls ON true
  LEFT JOIN LATERAL (SELECT min(h.at) AS at FROM ticket_source_history h WHERE h.ticket_id = t.id AND h.from_status IS NOT NULL) ss ON true;

-- The pipeline on each day, kept so trends and cumulative flow can be drawn (a ticket's phase today says nothing about last month).
CREATE TABLE ticket_daily_snapshot (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, day DATE NOT NULL, phase TEXT NOT NULL, tone TEXT NOT NULL,
  tickets INT NOT NULL, oldest_days NUMERIC(8,1) NOT NULL DEFAULT 0, PRIMARY KEY (project_id, day, phase));
ALTER TABLE ticket_daily_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON ticket_daily_snapshot USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_daily_snapshot TO design_max_app;
GRANT SELECT ON ticket_intervals_v, ticket_flow_v TO design_max_app;
