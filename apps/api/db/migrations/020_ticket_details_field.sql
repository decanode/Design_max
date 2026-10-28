-- Column-level security for the type-specific details (tickets.dynamic_metadata): roles start with the same access as the AI summary.
INSERT INTO ticket_field_access (role_id, field, access) SELECT role_id, 'details', access FROM ticket_field_access WHERE field = 'ai_summary' ON CONFLICT DO NOTHING;
INSERT INTO project_ticket_field_access (project_id, role_id, field, access) SELECT project_id, role_id, 'details', access FROM project_ticket_field_access WHERE field = 'ai_summary' ON CONFLICT DO NOTHING;
