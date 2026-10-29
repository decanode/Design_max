-- Approval workflows can also cover the creation of tickets, per ticket type. A ticket that needs approval waits (no phase moves, no
-- documents) until every level signs off; a rejection leaves it parked for the requester to fix and resubmit.
ALTER TABLE approval_workflows ADD COLUMN ticket_type_ids INT[] NOT NULL DEFAULT '{}';
ALTER TABLE approval_workflows DROP CONSTRAINT IF EXISTS approval_workflows_kinds_check;
ALTER TABLE approval_workflows ADD CONSTRAINT approval_workflows_kinds_check
  CHECK (kinds <@ ARRAY['FS','TS','TUT','CRC'] AND (cardinality(kinds) > 0 OR cardinality(ticket_type_ids) > 0));

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IS NULL OR kind IN ('FS','TS','TUT','CRC','TICKET'));
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check CHECK (kind IN ('FS','TS','TUT','CRC','TICKET'));

ALTER TABLE tickets ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','rejected'));

-- The database refuses phase moves while the ticket waits for (or was refused) its creation approval.
CREATE OR REPLACE FUNCTION enforce_ticket_state() RETURNS trigger AS $$
BEGIN
  IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
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
