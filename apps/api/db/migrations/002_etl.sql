ALTER TABLE tickets ADD COLUMN legacy_source TEXT CHECK (legacy_source IN ('jira','servicenow'));
ALTER TABLE tickets ADD COLUMN legacy_type TEXT;
ALTER TABLE tickets ADD COLUMN legacy_status TEXT;
ALTER TABLE tickets ADD COLUMN resolution_notes TEXT;
ALTER TABLE tickets ADD COLUMN acceptance_criteria TEXT;

CREATE TABLE ticket_comments (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id  UUID REFERENCES users(id),
  body       TEXT NOT NULL,
  legacy_id  TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attachments (
  id            BIGSERIAL PRIMARY KEY,
  ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  legacy_url    TEXT,
  legacy_id     TEXT UNIQUE,
  storage_key   TEXT,                 -- S3/Blob key once binary is migrated
  migrated_at   TIMESTAMPTZ
);

-- Legacy identity (Jira accountId / SNOW sys_id) -> Antigravity user
CREATE TABLE user_identity_map (
  source      TEXT NOT NULL,
  legacy_id   TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (source, legacy_id)
);

ALTER TABLE embeddings ADD CONSTRAINT embeddings_source_uq UNIQUE (source_type, source_ref);
