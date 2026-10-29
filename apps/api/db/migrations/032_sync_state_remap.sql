-- Lets the sync re-map the local phase of mirrored tickets nobody has worked on yet (after an admin changes a status map).
-- Only code that sets app.sync_remap in its own transaction can use it; the move is not logged as a ticket transition.
CREATE OR REPLACE FUNCTION enforce_ticket_state() RETURNS trigger AS $$
BEGIN
  IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
    IF COALESCE(current_setting('app.sync_remap', true), '') = 'on' THEN
      NEW.updated_at = now();
      RETURN NEW;
    END IF;
    IF OLD.approval_status IN ('pending','rejected') THEN
      RAISE EXCEPTION 'This ticket is waiting for approval' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM next_phases(NEW.project_id, NEW.ticket_type_id, OLD.current_state) n WHERE n.to_phase = NEW.current_state) THEN
      RAISE EXCEPTION 'Illegal state transition: % -> %', OLD.current_state, NEW.current_state USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO ticket_transitions (ticket_id, from_state, to_state) VALUES (NEW.id, OLD.current_state, NEW.current_state);
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
