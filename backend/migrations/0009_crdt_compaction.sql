-- Receipts survive binary log pruning. Hash + byte length identifies retries.
CREATE TABLE crdt_receipt (
    project_id UUID NOT NULL REFERENCES crdt_project(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    update_id UUID NOT NULL,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 1048576),
    validation TEXT NOT NULL CHECK (validation IN ('valid', 'pending_dependencies', 'quarantined')),
    committed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, sequence),
    UNIQUE (project_id, update_id)
);
INSERT INTO crdt_receipt
    SELECT project_id, sequence, update_id, sha256, octet_length(data), validation, committed_at FROM crdt_update;
CREATE TRIGGER crdt_receipt_is_immutable BEFORE UPDATE ON crdt_receipt
    FOR EACH ROW EXECUTE FUNCTION crdt_update_is_immutable();
CREATE FUNCTION crdt_record_receipt() RETURNS trigger AS $$
BEGIN
    INSERT INTO crdt_receipt VALUES (NEW.project_id, NEW.sequence, NEW.update_id,
        NEW.sha256, octet_length(NEW.data), NEW.validation, NEW.committed_at);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER crdt_record_receipt AFTER INSERT ON crdt_update
    FOR EACH ROW EXECUTE FUNCTION crdt_record_receipt();

ALTER TABLE crdt_checkpoint
    ADD COLUMN checkpoint_version SMALLINT NOT NULL DEFAULT 1 CHECK (checkpoint_version = 1),
    ADD COLUMN encoding TEXT NOT NULL DEFAULT 'yjs-v1' CHECK (encoding = 'yjs-v1');

-- Persist scheduling across restarts/processes; source rows stay intact on error.
ALTER TABLE crdt_project
    ADD COLUMN compaction_attempt_sequence BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN compaction_failures INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN compaction_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
