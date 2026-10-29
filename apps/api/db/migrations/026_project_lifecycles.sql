-- Project-owned lifecycles: a project can give any ticket type its own statuses and allowed moves, instead of the methodology's standard flow.
-- A ticket type without a row in project_flows keeps following the methodology exactly as before.

-- Statuses a project invents (for example "Awaiting vendor") belong to that project; platform statuses have no owner.
ALTER TABLE phases ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

CREATE TABLE project_flows (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_type_id INT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, ticket_type_id));
-- The statuses of the custom lifecycle, in board order.
CREATE TABLE project_flow_phases (
  project_id UUID NOT NULL, ticket_type_id INT NOT NULL, phase_id INT NOT NULL REFERENCES phases(id), position INT NOT NULL,
  PRIMARY KEY (project_id, ticket_type_id, phase_id),
  FOREIGN KEY (project_id, ticket_type_id) REFERENCES project_flows(project_id, ticket_type_id) ON DELETE CASCADE);
-- The allowed moves. from_phase_id NULL = where a new ticket starts. gated_reason keeps document/approval steps owned by that flow.
CREATE TABLE project_flow_edges (
  project_id UUID NOT NULL, ticket_type_id INT NOT NULL, from_phase_id INT REFERENCES phases(id), to_phase_id INT NOT NULL REFERENCES phases(id), gated_reason TEXT,
  FOREIGN KEY (project_id, ticket_type_id) REFERENCES project_flows(project_id, ticket_type_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX project_flow_edges_uq ON project_flow_edges (project_id, ticket_type_id, COALESCE(from_phase_id, 0), to_phase_id);

ALTER TABLE project_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_flow_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_flow_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON project_flows USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
CREATE POLICY project_isolation ON project_flow_phases USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
CREATE POLICY project_isolation ON project_flow_edges USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_flows, project_flow_phases, project_flow_edges TO design_max_app;

-- Same function as before, but a ticket type with a project flow of its own follows that flow, move by move.
CREATE OR REPLACE FUNCTION next_phases(p_project UUID, p_type INT, p_from TEXT)
RETURNS TABLE (to_phase TEXT, gated_reason TEXT) LANGUAGE sql STABLE AS $$
  SELECT ph.name, fe.gated_reason FROM project_flow_edges fe
    JOIN phases ph ON ph.id = fe.to_phase_id LEFT JOIN phases pf ON pf.id = fe.from_phase_id
   WHERE fe.project_id = p_project AND fe.ticket_type_id = p_type AND ((p_from IS NULL AND fe.from_phase_id IS NULL) OR pf.name = p_from)
  UNION ALL
  SELECT s.to_phase, s.gated_reason FROM (
    WITH RECURSIVE
    cfg AS (SELECT template_type_id AS tt FROM projects WHERE id = p_project),
    own AS (SELECT EXISTS (SELECT 1 FROM workflow_transitions w, cfg WHERE w.template_type_id = cfg.tt AND w.ticket_type_id = p_type) AS has),
    e AS (
      SELECT w.from_phase_id AS f, w.to_phase_id AS t, w.gated_reason AS g
      FROM workflow_transitions w, cfg, own
      WHERE w.template_type_id = cfg.tt AND ((own.has AND w.ticket_type_id = p_type) OR (NOT own.has AND w.ticket_type_id IS NULL))),
    en AS (SELECT phase_id FROM project_phases WHERE project_id = p_project AND enabled),
    walk(t, g, depth) AS (
      SELECT e.t, e.g, 1 FROM e LEFT JOIN phases pf ON pf.id = e.f
      WHERE (p_from IS NULL AND e.f IS NULL) OR (p_from IS NOT NULL AND pf.name = p_from)
      UNION
      SELECT e2.t, COALESCE(w.g, e2.g), w.depth + 1 FROM walk w JOIN e e2 ON e2.f = w.t
      WHERE w.t NOT IN (SELECT phase_id FROM en) AND w.depth < 12)
    SELECT DISTINCT ON (ph.name) ph.name AS to_phase, walk.g AS gated_reason FROM walk JOIN phases ph ON ph.id = walk.t
    WHERE walk.t IN (SELECT phase_id FROM en) ORDER BY ph.name, (walk.g IS NULL)
  ) s WHERE NOT EXISTS (SELECT 1 FROM project_flows f WHERE f.project_id = p_project AND f.ticket_type_id = p_type)
$$;
