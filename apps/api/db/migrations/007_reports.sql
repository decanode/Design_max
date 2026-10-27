-- Customizable reports and dashboards. Reports are saved, validated definitions run by a whitelisted query
-- engine (never user-written SQL). Widgets on a dashboard live in its `layout` JSON: [{id, reportId, size 1-3}].
CREATE TABLE reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition  JSONB NOT NULL,
  owner_id    UUID REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dashboards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  layout      JSONB NOT NULL DEFAULT '[]',
  owner_id    UUID REFERENCES users(id),
  visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Built-in reports and a starter dashboard (shared, owned by no one; copy them to customize).
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('a2781635-43c5-4002-9847-92ef76ba4377', 'Open tickets', 'Tickets not yet deployed.', '{"dataset": "tickets", "measure": "count", "groupBy": null, "filters": {"openOnly": true}, "sort": "natural", "limit": 12, "chart": "kpi"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('5a756e54-9510-4570-ad55-3814bf796834', 'Average age of open tickets (days)', 'How long open tickets have been waiting.', '{"dataset": "tickets", "measure": "avg_age_days", "groupBy": null, "filters": {"openOnly": true}, "sort": "natural", "limit": 12, "chart": "kpi"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('6bfe621e-e3dd-4f42-afe8-879b44f7807b', 'Average approval time (hours)', 'From request to decision, decided approvals only.', '{"dataset": "approvals", "measure": "avg_decision_hours", "groupBy": null, "filters": {}, "sort": "natural", "limit": 12, "chart": "kpi"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('1476e2bf-cf60-4baa-bb77-c8917e6700c3', 'Tickets by phase', 'Where every ticket currently sits in the lifecycle.', '{"dataset": "tickets", "measure": "count", "groupBy": "state", "filters": {}, "sort": "natural", "limit": 12, "chart": "column"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('17598c44-e422-4951-acb8-c47f07b8bb33', 'Approvals by status', 'Share of approval requests by outcome.', '{"dataset": "approvals", "measure": "count", "groupBy": "status", "filters": {}, "sort": "value_desc", "limit": 6, "chart": "share"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('116a7043-13ae-4b9d-aac5-753a51c5c194', 'New tickets per month', 'Tickets created in the last 12 months.', '{"dataset": "tickets", "measure": "count", "groupBy": "created_month", "filters": {"range": "365d"}, "sort": "natural", "limit": 12, "chart": "line"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('69b57657-e08a-4f41-8039-df05e53e34d3', 'Deployments per month', 'Tickets reaching Deployed in the last 12 months.', '{"dataset": "transitions", "measure": "count", "groupBy": "month", "filters": {"states": ["Deployed"], "range": "365d"}, "sort": "natural", "limit": 12, "chart": "column"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('fea15648-44cb-4d9c-a7b9-d6dd8267e36a', 'Open workload by consultant', 'Open tickets per assigned consultant.', '{"dataset": "tickets", "measure": "count", "groupBy": "consultant", "filters": {"openOnly": true}, "sort": "value_desc", "limit": 10, "chart": "bar"}', 'shared', true);
INSERT INTO reports (id, name, description, definition, visibility, is_system) VALUES ('d0fa1d38-be80-4522-9876-bf6bb4d263d9', 'Tickets by source', 'Native tickets versus those migrated from Jira or ServiceNow.', '{"dataset": "tickets", "measure": "count", "groupBy": "source", "filters": {}, "sort": "value_desc", "limit": 6, "chart": "share"}', 'shared', true);

INSERT INTO dashboards (id, name, description, layout, visibility, is_system) VALUES ('8274254f-cbf5-4219-b1cc-28f040c811ab', 'Delivery overview', 'Pipeline health, throughput and approvals at a glance.', '[{"id": "cacbafc7-2b5c-48b3-a6a5-f3358d11ba82", "reportId": "a2781635-43c5-4002-9847-92ef76ba4377", "size": 1}, {"id": "dab00edb-c7ea-4abb-8c46-328495d30693", "reportId": "5a756e54-9510-4570-ad55-3814bf796834", "size": 1}, {"id": "9548cd28-5b77-4ea6-a923-f4e48070f839", "reportId": "6bfe621e-e3dd-4f42-afe8-879b44f7807b", "size": 1}, {"id": "3544f41c-22f4-413f-8a8c-83ffcfc5d8bc", "reportId": "1476e2bf-cf60-4baa-bb77-c8917e6700c3", "size": 2}, {"id": "914fc1f7-5e5b-4e44-b11c-2f4992cdc04f", "reportId": "17598c44-e422-4951-acb8-c47f07b8bb33", "size": 1}, {"id": "1576d1a3-a44e-487d-975a-6bb2042645fa", "reportId": "116a7043-13ae-4b9d-aac5-753a51c5c194", "size": 2}, {"id": "a4c33627-1314-4766-b45a-0938e6a231be", "reportId": "69b57657-e08a-4f41-8039-df05e53e34d3", "size": 1}, {"id": "eba979d0-7c54-4884-946b-d0226829e364", "reportId": "fea15648-44cb-4d9c-a7b9-d6dd8267e36a", "size": 2}, {"id": "81601dec-7ed8-41b8-8e8b-8a711c77eb5d", "reportId": "d0fa1d38-be80-4522-9876-bf6bb4d263d9", "size": 1}]', 'shared', true);

-- Permissions: view dashboards, build your own, and manage everyone's.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, d.p FROM roles r JOIN (VALUES
  ('Consultant', 'report.view'),
  ('Lead', 'report.view'), ('Lead', 'report.build'),
  ('Manager', 'report.view'), ('Manager', 'report.build')
) AS d(role, p) ON d.role = r.name;
