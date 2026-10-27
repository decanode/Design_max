-- More document types (TUT = Technical Unit Test, CRC = Code Review Checklist), structured content for versions,
-- per-project document settings, and the document template library.

-- Versions now carry structured content (ProseMirror JSON) and a plain-text rendering used for diffs, checks and search.
-- Legacy rows keep their Markdown; readers convert it on demand.
ALTER TABLE documents ALTER COLUMN content_md DROP NOT NULL;
ALTER TABLE documents ADD COLUMN content_json JSONB;
ALTER TABLE documents ADD COLUMN content_text TEXT;
ALTER TABLE documents DISABLE TRIGGER documents_no_update;     -- one-off backfill of immutable rows, as the owner
UPDATE documents SET content_text = content_md WHERE content_text IS NULL;
ALTER TABLE documents ENABLE TRIGGER documents_no_update;

-- Drop every "kind IN ('FS','TS')" style check and replace it with the four types.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
           WHERE contype = 'c' AND conrelid IN ('documents'::regclass, 'approvals'::regclass, 'approval_requests'::regclass, 'approval_workflows'::regclass)
             AND pg_get_constraintdef(oid) ~ 'kind' AND pg_get_constraintdef(oid) ~ 'FS'
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.t, c.conname); END LOOP;
END $$;
ALTER TABLE documents          ADD CONSTRAINT documents_kind_check          CHECK (kind IN ('FS','TS','TUT','CRC'));
ALTER TABLE approvals          ADD CONSTRAINT approvals_kind_check          CHECK (kind IS NULL OR kind IN ('FS','TS','TUT','CRC'));
ALTER TABLE approval_requests  ADD CONSTRAINT approval_requests_kind_check  CHECK (kind IN ('FS','TS','TUT','CRC'));
ALTER TABLE approval_workflows ADD CONSTRAINT approval_workflows_kinds_check CHECK (cardinality(kinds) > 0 AND kinds <@ ARRAY['FS','TS','TUT','CRC']);

-- The standard workflow now also covers the two new document types (only where nothing else already covers them).
UPDATE approval_workflows w SET kinds = kinds || ARRAY['TUT','CRC']
WHERE w.name = 'Standard approval' AND NOT (kinds && ARRAY['TUT','CRC'])
  AND NOT EXISTS (SELECT 1 FROM approval_workflows o WHERE o.id <> w.id AND o.active AND o.project_id IS NOT DISTINCT FROM w.project_id AND o.kinds && ARRAY['TUT','CRC']);

-- Document settings per project (branding, fonts, numbering, which template set, the optional QA gate) and platform defaults.
CREATE TABLE project_doc_settings (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE project_doc_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON project_doc_settings USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());

CREATE TABLE platform_doc_defaults (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_doc_defaults (id) VALUES (1);

-- Template library (platform-owned, readable by every project): the Word design for a technology and document type.
-- `stack` NULL = generic. The section structure comes from built-in definitions unless `definition` overrides it.
CREATE TABLE doc_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stack       TEXT,
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('FS','TS','TUT','CRC')),
  name        TEXT NOT NULL,
  version     INT  NOT NULL DEFAULT 1,
  docx        BYTEA NOT NULL,
  definition  JSONB,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX doc_templates_active_uq ON doc_templates (COALESCE(stack, ''), doc_type) WHERE active;
