CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE roles (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
INSERT INTO roles (name) VALUES
  ('Project_Admin'), ('Consultant'), ('Customer'), ('Approver');

CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  idp_subject TEXT UNIQUE,            -- Entra ID subject (SSO, Sprint 4)
  role_id     INT NOT NULL REFERENCES roles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  scope         TEXT,
  target_env    TEXT,
  sharepoint_url TEXT,
  git_url       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE ticket_state AS ENUM (
  'Requirement Verified', 'FS Drafted', 'FS Approved', 'TS Drafted',
  'TS Approved', 'Development', 'QA', 'UAT', 'Deployed'
);

CREATE TABLE tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  current_state ticket_state NOT NULL DEFAULT 'Requirement Verified',
  customer_id   UUID REFERENCES users(id),
  consultant_id UUID REFERENCES users(id),
  ai_summary    TEXT,
  legacy_id     TEXT,                 -- Jira / ServiceNow origin key
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tickets_legacy_id_uq ON tickets(legacy_id) WHERE legacy_id IS NOT NULL;

-- Immutable audit trail of every transition.
CREATE TABLE ticket_transitions (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  UUID NOT NULL REFERENCES tickets(id),
  from_state ticket_state,
  to_state   ticket_state NOT NULL,
  actor_id   UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id),
  approver_id UUID NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);

CREATE TABLE documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      UUID NOT NULL REFERENCES tickets(id),
  kind           TEXT NOT NULL CHECK (kind IN ('FS','TS')),
  version_number INT NOT NULL,
  content_md     TEXT NOT NULL,
  author_id      UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, kind, version_number)
);

CREATE TABLE embeddings (
  id          BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('ticket','sap_metadata','git','kb_doc')),
  source_ref  TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- State machine enforced at DB level: forward-only, one step at a time.
CREATE FUNCTION enforce_ticket_state() RETURNS trigger AS $$
BEGIN
  IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
    IF (enum_range(NULL::ticket_state))[array_position(enum_range(NULL::ticket_state), OLD.current_state) + 1]
       IS DISTINCT FROM NEW.current_state THEN
      RAISE EXCEPTION 'Illegal state transition: % -> %', OLD.current_state, NEW.current_state
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO ticket_transitions (ticket_id, from_state, to_state)
      VALUES (NEW.id, OLD.current_state, NEW.current_state);
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_state_guard BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION enforce_ticket_state();

CREATE FUNCTION log_initial_state() RETURNS trigger AS $$
BEGIN
  INSERT INTO ticket_transitions (ticket_id, from_state, to_state) VALUES (NEW.id, NULL, NEW.current_state);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tickets_initial_log AFTER INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION log_initial_state();
