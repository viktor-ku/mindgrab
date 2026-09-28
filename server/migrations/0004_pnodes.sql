ALTER TABLE project
    ADD CONSTRAINT project_id_user_id_unique UNIQUE (id, user_id);

CREATE TABLE pnode (
    id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    text TEXT NOT NULL,
    parent_pnode_id TEXT,
    sort_order BIGINT NOT NULL DEFAULT 0,
    position_x DOUBLE PRECISION,
    position_y DOUBLE PRECISION,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id, user_id)
        REFERENCES project (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, parent_pnode_id)
        REFERENCES pnode (project_id, id) ON DELETE CASCADE,
    CHECK (parent_pnode_id IS NULL OR parent_pnode_id <> id),
    CHECK ((position_x IS NULL) = (position_y IS NULL))
);

CREATE INDEX pnode_user_id ON pnode (user_id);
CREATE INDEX pnode_parent ON pnode (project_id, parent_pnode_id, sort_order);
