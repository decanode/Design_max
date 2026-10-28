-- The chat becomes a conversation with an assistant that adapts to who is talking.

-- The assistant's own messages.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'messages'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%sender_role%'
  LOOP EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE messages ADD CONSTRAINT messages_sender_role_check CHECK (sender_role IN ('customer','consultant','assistant','system'));

-- Who opened the conversation and how the assistant should treat them, and where the conversation stands.
ALTER TABLE conversations
  ADD COLUMN opened_by   UUID REFERENCES users(id),
  ADD COLUMN persona     TEXT NOT NULL DEFAULT 'customer' CHECK (persona IN ('customer','team')),
  ADD COLUMN intent      TEXT,
  ADD COLUMN stage       TEXT NOT NULL DEFAULT 'discovery' CHECK (stage IN ('greeting','discovery','self_help','scoping','confirm','done')),
  ADD COLUMN outcome     TEXT CHECK (outcome IN ('ticket_created','self_resolved','solution_given')),
  ADD COLUMN suggestions JSONB NOT NULL DEFAULT '[]';           -- the quick replies currently on offer
UPDATE conversations SET opened_by = customer_id;

-- The working scope: the full text, the ticket it would become, and what is still missing.
ALTER TABLE requirement_drafts
  ADD COLUMN scope_md        TEXT,
  ADD COLUMN ticket_type_key TEXT,
  ADD COLUMN ticket_fields   JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN ready           BOOLEAN NOT NULL DEFAULT false,   -- the person has seen the full scope and the ticket has everything it needs
  ADD COLUMN missing         JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN deliverable     TEXT NOT NULL DEFAULT 'ticket' CHECK (deliverable IN ('ticket','solution','undecided'));

-- Anyone who can open a conversation can confirm the ticket it produces (creating it still needs the right to create that kind of ticket on the board).
INSERT INTO role_permissions (role_id, permission) SELECT id, 'chat.verify' FROM roles WHERE name IN ('Consultant','Lead','Project Manager') ON CONFLICT DO NOTHING;
