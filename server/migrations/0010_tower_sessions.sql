-- Legacy token_hash credentials remain valid until expiry or explicit rotation.
-- Keep local session data beside its provider row: deleting authority also deletes
-- the record, and late generic saves can only UPDATE, never resurrect it.
ALTER TABLE auth_sessions
    ADD COLUMN browser_hash TEXT UNIQUE,
    ADD COLUMN session_data JSONB NOT NULL DEFAULT '{}';
