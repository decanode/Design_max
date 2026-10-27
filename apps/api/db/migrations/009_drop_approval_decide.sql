-- Approvers are now defined by approval workflows: being asked is the authority to decide.
-- The separate permission could only get in the way (a workflow names a role that lacks it), so it is removed.
DELETE FROM role_permissions WHERE permission = 'approval.decide';
