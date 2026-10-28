-- A ticket whose project cannot be resolved (for example another project's, hidden by row-level security) must fail on that, not on the starting phase.
CREATE OR REPLACE FUNCTION ticket_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.ticket_type_id IS NULL THEN
    SELECT ticket_type_id INTO NEW.ticket_type_id FROM project_ticket_types WHERE project_id = NEW.project_id AND enabled ORDER BY is_default DESC, ticket_type_id LIMIT 1;
  END IF;
  IF NEW.current_state IS NULL THEN
    SELECT to_phase INTO NEW.current_state FROM next_phases(NEW.project_id, NEW.ticket_type_id, NULL) ORDER BY to_phase LIMIT 1;
  ELSIF NOT EXISTS (SELECT 1 FROM phases WHERE name = NEW.current_state) THEN
    RAISE EXCEPTION 'Unknown phase %', NEW.current_state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
