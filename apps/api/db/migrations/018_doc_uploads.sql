-- Word files that people upload to merge into a document. The original is kept for audit.
CREATE TABLE doc_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id    UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('FS','TS','TUT','CRC')),
  filename     TEXT NOT NULL,
  original     BYTEA NOT NULL,
  content_json JSONB NOT NULL,
  uploaded_by  UUID NOT NULL REFERENCES users(id),
  merged_as    INT,                         -- the version created from it, once merged
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX doc_uploads_doc ON doc_uploads (ticket_id, kind, created_at);
ALTER TABLE doc_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON doc_uploads USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON doc_uploads TO design_max_app;
