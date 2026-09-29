-- Disposable indexes of canonical binary content, published under the project
-- row lock. Never used as input to ingestion, synchronization or checkpoints.
ALTER TABLE crdt_project
    ADD COLUMN name_utf8 BYTEA CHECK (name_utf8 IS NULL OR octet_length(name_utf8) <= 200),
    ADD COLUMN node_count INTEGER CHECK (node_count >= 0),
    ADD COLUMN projection_sequence BIGINT CHECK (projection_sequence >= 0 AND projection_sequence <= last_sequence),
    ADD COLUMN projection_attempt_sequence BIGINT NOT NULL DEFAULT 0 CHECK (projection_attempt_sequence >= 0 AND projection_attempt_sequence <= last_sequence),
    ADD COLUMN projection_version SMALLINT,
    ADD COLUMN projection_status TEXT NOT NULL DEFAULT 'uninitialized'
        CHECK (projection_status IN ('uninitialized', 'ready', 'pending_dependencies', 'quarantined'));

CREATE TABLE crdt_node_read (
    project_id UUID NOT NULL REFERENCES crdt_project(id) ON DELETE CASCADE,
    node_id UUID NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
    -- UTF-8 bytes preserve NUL, which is valid Y.Text but not PostgreSQL TEXT.
    text BYTEA NOT NULL,
    color TEXT NOT NULL,
    deleted BOOLEAN NOT NULL,
    stored_parent UUID,
    rank TEXT NOT NULL,
    position_x DOUBLE PRECISION,
    position_y DOUBLE PRECISION,
    effective_parent UUID,
    sibling_order INTEGER CHECK (sibling_order >= 0),
    CHECK ((position_x IS NULL) = (position_y IS NULL)),
    CHECK (deleted = (sibling_order IS NULL)),
    PRIMARY KEY (project_id, node_id)
);

CREATE INDEX crdt_node_read_children ON crdt_node_read (project_id, effective_parent, sibling_order)
    WHERE NOT deleted;

CREATE INDEX crdt_project_read_model_pending ON crdt_project (id)
    WHERE last_sequence > 0 AND (projection_attempt_sequence < last_sequence OR projection_version IS DISTINCT FROM 1);
