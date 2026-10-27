-- Role-based access control: roles carry feature permissions; Admin implicitly has all of them.
ALTER TABLE roles ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE roles ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE roles SET name = 'Admin' WHERE name = 'Project_Admin';
INSERT INTO roles (name) VALUES ('Lead'), ('Manager') ON CONFLICT (name) DO NOTHING;

UPDATE roles SET is_system = true, description = CASE name
  WHEN 'Customer'   THEN 'Raises requirements through chat and follows their own requests.'
  WHEN 'Consultant' THEN 'Works requirements: answers chats, drafts and edits specifications, requests approvals.'
  WHEN 'Lead'       THEN 'Oversees the team: assigns work, sees all tickets and team workload.'
  WHEN 'Manager'    THEN 'Approves specifications and watches the portfolio.'
  WHEN 'Admin'      THEN 'Full access, including roles and users. Cannot be restricted.'
  WHEN 'Approver'   THEN 'External approver reached by emailed link only.'
END WHERE name IN ('Customer','Consultant','Lead','Manager','Admin','Approver');

CREATE TABLE role_permissions (
  role_id    INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p FROM roles r JOIN (VALUES
  ('Customer',   'board.view'), ('Customer', 'ticket.view_own'), ('Customer', 'chat.as_customer'), ('Customer', 'chat.verify'), ('Customer', 'spec.view'),
  ('Consultant', 'board.view'), ('Consultant', 'ticket.view_own'), ('Consultant', 'ticket.view_unassigned'), ('Consultant', 'ticket.claim'),
  ('Consultant', 'chat.as_consultant'), ('Consultant', 'chat.view_all'), ('Consultant', 'spec.view'), ('Consultant', 'spec.generate'),
  ('Consultant', 'spec.edit'), ('Consultant', 'approval.request'),
  ('Lead', 'board.view'), ('Lead', 'ticket.view_all'), ('Lead', 'ticket.create'), ('Lead', 'ticket.claim'), ('Lead', 'ticket.assign'), ('Lead', 'ticket.advance'),
  ('Lead', 'chat.as_consultant'), ('Lead', 'chat.view_all'), ('Lead', 'spec.view'), ('Lead', 'spec.generate'), ('Lead', 'spec.edit'),
  ('Lead', 'approval.request'), ('Lead', 'dashboard.team'),
  ('Manager', 'board.view'), ('Manager', 'ticket.view_all'), ('Manager', 'ticket.advance'), ('Manager', 'chat.view_all'), ('Manager', 'spec.view'),
  ('Manager', 'approval.decide'), ('Manager', 'dashboard.portfolio')
) AS d(role, p) ON d.role = r.name;

ALTER TABLE users ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE conversations ADD COLUMN customer_id UUID REFERENCES users(id);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
