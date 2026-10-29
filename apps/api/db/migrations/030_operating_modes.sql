-- How much of Design Max a project uses. 'full' is how every project has always behaved.
--   full      the whole lifecycle lives here
--   connected the customer keeps Jira / ServiceNow as the system of record; tickets are pulled in, agreed outcomes are sent back
--   mirror    tickets are pulled in read-only and worked locally; nothing is ever sent back
ALTER TABLE projects ADD COLUMN operating_mode TEXT NOT NULL DEFAULT 'full' CHECK (operating_mode IN ('full','connected','mirror'));
-- A Super Admin can adjust a few capabilities within a mode (see rbac/modes.ts for which).
ALTER TABLE projects ADD COLUMN mode_overrides JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(mode_overrides) = 'object');
