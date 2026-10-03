ALTER TABLE crdt_project ADD COLUMN validation TEXT NOT NULL DEFAULT 'pending_dependencies'
    CHECK (validation IN ('valid', 'pending_dependencies', 'quarantined'));

CREATE TABLE crdt_update (
    project_id UUID NOT NULL REFERENCES crdt_project(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    update_id UUID NOT NULL,
    data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 2 AND 1048576),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- The receipt is immutable, even when later dependencies change project status.
    validation TEXT NOT NULL CHECK (validation IN ('valid', 'pending_dependencies', 'quarantined')),
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, sequence),
    UNIQUE (project_id, update_id)
);

CREATE TABLE crdt_checkpoint (
    project_id UUID PRIMARY KEY REFERENCES crdt_project(id) ON DELETE CASCADE,
    covered_sequence BIGINT NOT NULL CHECK (covered_sequence >= 0),
    data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 2 AND 10485760),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION crdt_update_is_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'crdt_update bytes and receipts are immutable'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crdt_update_is_immutable BEFORE UPDATE ON crdt_update
    FOR EACH ROW EXECUTE FUNCTION crdt_update_is_immutable();
