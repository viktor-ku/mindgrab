-- UUID-identified Yjs projects. Independent of the legacy name-keyed `project`
-- table; existing development data is not converted.
CREATE TABLE crdt_project (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    protocol_version SMALLINT NOT NULL CHECK (protocol_version = 1),
    schema_version SMALLINT NOT NULL CHECK (schema_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Rebuildable summaries projected from accepted document content. Names are
    -- not unique and are NULL until content has been accepted.
    name TEXT CHECK (name IS NULL OR (octet_length(name) <= 200 AND btrim(name) <> '')),
    last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    content_updated_at TIMESTAMPTZ,
    UNIQUE (id, owner_id)
);

CREATE INDEX crdt_project_owner_page ON crdt_project (owner_id, created_at DESC, id DESC);

CREATE FUNCTION crdt_project_identity_is_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.created_at <> OLD.created_at
        OR NEW.protocol_version <> OLD.protocol_version THEN
        RAISE EXCEPTION 'crdt_project identity, owner, and creation metadata are immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crdt_project_identity_is_immutable
    BEFORE UPDATE ON crdt_project
    FOR EACH ROW EXECUTE FUNCTION crdt_project_identity_is_immutable();
