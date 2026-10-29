-- A source tool can tell us "something changed" so we look straight away instead of at the next check. Only a hash of the token is kept.
ALTER TABLE integration_connections ADD COLUMN webhook_token_hash TEXT;
