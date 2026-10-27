-- Who downloaded which version of which document, and when. Isolated per project through the ticket, like everything else.
CREATE TABLE doc_exports (
  id             BIGSERIAL PRIMARY KEY,
  ticket_id      UUID NOT NULL REFERENCES tickets(id),
  kind           TEXT NOT NULL,
  version_number INT  NOT NULL,
  format         TEXT NOT NULL DEFAULT 'docx',
  exported_by    UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX doc_exports_ticket_idx ON doc_exports(ticket_id);
ALTER TABLE doc_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_ticket ON doc_exports USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = doc_exports.ticket_id)) WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id = doc_exports.ticket_id));
