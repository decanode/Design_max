-- Review comments on documents (anchored threads, replies, resolve) and review rounds.
CREATE TABLE doc_comments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('FS','TS','TUT','CRC')),
  parent_id      UUID REFERENCES doc_comments(id) ON DELETE CASCADE,
  author_id      UUID NOT NULL REFERENCES users(id),
  author_name    TEXT NOT NULL,
  body           TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  quote          TEXT,                    -- the text that was selected, kept so an orphaned comment still shows what it was about
  anchor         JSONB,                   -- {from, to}: Yjs relative positions, so the anchor moves with the text
  version_number INT,                     -- the latest saved version when the comment was written
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed','resolved')),
  resolved_by    UUID REFERENCES users(id),
  resolved_at    TIMESTAMPTZ,
  mentions       UUID[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at      TIMESTAMPTZ
);
CREATE INDEX doc_comments_doc ON doc_comments (ticket_id, kind, created_at);
ALTER TABLE doc_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON doc_comments USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());

CREATE TABLE doc_reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('FS','TS','TUT','CRC')),
  reviewer_id    UUID NOT NULL REFERENCES users(id),
  reviewer_name  TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('changes_requested','looks_good')),
  note           TEXT,
  version_number INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX doc_reviews_doc ON doc_reviews (ticket_id, kind, created_at);
ALTER TABLE doc_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_isolation ON doc_reviews USING (app_platform() OR project_id = app_project()) WITH CHECK (app_platform() OR project_id = app_project());
GRANT SELECT, INSERT, UPDATE, DELETE ON doc_comments, doc_reviews TO design_max_app;

-- Everyone who can read specifications can comment; Leads, Managers, Approvers and Admins can also run a review.
INSERT INTO role_permissions (role_id, permission)
  SELECT role_id, 'doc.comment' FROM role_permissions WHERE permission = 'spec.view' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission)
  SELECT id, 'doc.review' FROM roles WHERE name IN ('Lead','Manager','Approver','Admin') ON CONFLICT DO NOTHING;
