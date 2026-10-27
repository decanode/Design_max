-- The live working draft of a document: the shared (Yjs) state that people edit together. Versions stay immutable snapshots.
CREATE TABLE document_drafts (
  ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('FS','TS','TUT','CRC')),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ydoc       BYTEA NOT NULL,
  based_on   INT NOT NULL DEFAULT 0,        -- the version this draft started from
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, kind)
);
ALTER TABLE document_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON document_drafts USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON document_drafts TO design_max_app;
