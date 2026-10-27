-- Configurable multi-level approval workflows (L1, L2, L3, ...), ServiceNow-style.
CREATE TABLE approval_workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kinds       TEXT[] NOT NULL CHECK (cardinality(kinds) > 0 AND kinds <@ ARRAY['FS','TS']),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,        -- NULL = applies to every project
  active      BOOLEAN NOT NULL DEFAULT true,
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approval_levels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES approval_workflows(id) ON DELETE CASCADE,
  position    INT  NOT NULL CHECK (position BETWEEN 1 AND 10),
  name        TEXT NOT NULL,
  rule        TEXT NOT NULL DEFAULT 'any' CHECK (rule IN ('any','all')),   -- any one approver, or every one of them
  UNIQUE (workflow_id, position)
);

CREATE TABLE approval_level_approvers (
  id       BIGSERIAL PRIMARY KEY,
  level_id UUID NOT NULL REFERENCES approval_levels(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('user','role')),
  user_id  UUID REFERENCES users(id),
  role_id  INT  REFERENCES roles(id),
  CHECK ((kind = 'user' AND user_id IS NOT NULL AND role_id IS NULL) OR (kind = 'role' AND role_id IS NOT NULL AND user_id IS NULL))
);

-- One request per document version; it carries a frozen copy of the workflow so later edits never change it mid-flight.
CREATE TABLE approval_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES tickets(id),
  kind          TEXT NOT NULL CHECK (kind IN ('FS','TS')),
  version_number INT NOT NULL,
  workflow_id   UUID REFERENCES approval_workflows(id) ON DELETE SET NULL,
  workflow_name TEXT NOT NULL,
  levels        JSONB NOT NULL,
  current_level INT NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','approved','rejected','superseded','cancelled')),
  requested_by  UUID REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX approval_requests_one_active ON approval_requests (ticket_id, kind) WHERE status = 'in_progress';

-- `approvals` rows become the individual tasks of a request level.
ALTER TABLE approvals ADD COLUMN request_id UUID REFERENCES approval_requests(id) ON DELETE CASCADE;
ALTER TABLE approvals ADD COLUMN level INT;
ALTER TABLE approvals ADD COLUMN level_name TEXT;
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending','approved','rejected','superseded','skipped'));
DROP INDEX approvals_one_pending;   -- several people can be pending at one level now; one active request per document is enforced above

-- Built-in default: one level, any Manager. Admins can edit it or add their own.
WITH w AS (
  INSERT INTO approval_workflows (name, description, kinds, is_system)
  VALUES ('Standard approval', 'Any Manager approves both specifications.', ARRAY['FS','TS'], true) RETURNING id
), l AS (
  INSERT INTO approval_levels (workflow_id, position, name, rule) SELECT id, 1, 'L1', 'any' FROM w RETURNING id
)
INSERT INTO approval_level_approvers (level_id, kind, role_id) SELECT l.id, 'role', r.id FROM l, roles r WHERE r.name = 'Manager';
