-- Column-level security for tickets: per role, per field (a field is one or more columns): hidden | read | write.
-- Admin is implicit write on everything and has no rows. A role with no row for a field falls back to the field's
-- new-role default (title readable, everything else hidden), so a freshly built role is closed until an Admin opens it.
CREATE TABLE ticket_field_access (
  role_id INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  field   TEXT NOT NULL,
  access  TEXT NOT NULL CHECK (access IN ('hidden','read','write')),
  PRIMARY KEY (role_id, field)
);

-- Existing roles keep today's behaviour: they can read every field (custom roles that already exist included),
-- then the built-in roles are tuned to sensible defaults an Admin can change.
INSERT INTO ticket_field_access (role_id, field, access)
SELECT r.id, f.field, 'read' FROM roles r CROSS JOIN (VALUES
  ('title'),('ai_summary'),('customer'),('consultant'),('project'),('legacy'),('resolution_notes'),('acceptance_criteria')
) AS f(field) WHERE r.name <> 'Admin';

UPDATE ticket_field_access a SET access = 'hidden'
FROM roles r WHERE r.id = a.role_id AND r.name = 'Customer' AND a.field = 'legacy';     -- internal Jira / ServiceNow keys

UPDATE ticket_field_access a SET access = 'hidden'
FROM roles r WHERE r.id = a.role_id AND r.name = 'Approver' AND a.field IN ('customer','consultant','project','legacy','resolution_notes','acceptance_criteria');

UPDATE ticket_field_access a SET access = 'write'
FROM roles r WHERE r.id = a.role_id AND (
  (r.name = 'Consultant' AND a.field IN ('title','ai_summary','consultant','resolution_notes','acceptance_criteria')) OR
  (r.name = 'Lead'       AND a.field IN ('title','ai_summary','consultant','resolution_notes','acceptance_criteria'))
);
