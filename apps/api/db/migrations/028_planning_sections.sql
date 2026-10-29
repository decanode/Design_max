-- Planning is now three switchable parts (charter, work breakdown, request-item preparation). Projects that already had Planning keep all three.
UPDATE projects SET enabled_modules = enabled_modules || '{"project_charter": true, "wbs": true, "ritm_prep": true}'::jsonb
WHERE enabled_modules->>'planning_module' = 'true';
