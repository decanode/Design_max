-- Document revisions are immutable.
ALTER TABLE documents ADD COLUMN author_name TEXT;
ALTER TABLE documents ADD COLUMN change_note TEXT;
CREATE FUNCTION documents_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Document revisions are immutable' USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER documents_no_update BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION documents_immutable();

-- Approvals are tied to one document version and a single-use emailed token (only its hash is stored).
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending','approved','rejected','superseded'));
ALTER TABLE approvals ADD COLUMN kind TEXT CHECK (kind IN ('FS','TS'));
ALTER TABLE approvals ADD COLUMN version_number INT;
ALTER TABLE approvals ADD COLUMN token_hash TEXT UNIQUE;
ALTER TABLE approvals ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN comment TEXT;
CREATE UNIQUE INDEX approvals_one_pending ON approvals(ticket_id, kind) WHERE status = 'pending';

-- Dev/local mailbox. Replaced by an M365 sender later.
CREATE TABLE email_outbox (
  id         BIGSERIAL PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
