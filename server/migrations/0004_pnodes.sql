ALTER TABLE project
    ADD COLUMN view_left DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN view_top DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN view_zoom DOUBLE PRECISION NOT NULL DEFAULT 1,
    ADD COLUMN anchor_pnode_id TEXT,
    ADD COLUMN anchor_center_y DOUBLE PRECISION,
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

WITH RECURSIVE node_tree AS (
    SELECT
        project.id AS project_id,
        project.user_id,
        project.created_at,
        project.updated_at,
        root.value AS node,
        NULL::TEXT AS parent_pnode_id,
        root.ordinality::BIGINT - 1 AS sort_order,
        0 AS depth
    FROM project
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(project.state -> 'nodes') = 'array'
                THEN project.state -> 'nodes'
            ELSE '[]'::JSONB
        END
    ) WITH ORDINALITY AS root(value, ordinality)

    UNION ALL

    SELECT
        node_tree.project_id,
        node_tree.user_id,
        node_tree.created_at,
        node_tree.updated_at,
        child.value AS node,
        node_tree.node ->> 'id' AS parent_pnode_id,
        child.ordinality::BIGINT - 1 AS sort_order,
        node_tree.depth + 1 AS depth
    FROM node_tree
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(node_tree.node -> 'next') = 'array'
                THEN node_tree.node -> 'next'
            ELSE '[]'::JSONB
        END
    ) WITH ORDINALITY AS child(value, ordinality)
    WHERE jsonb_typeof(node_tree.node) = 'object'
      AND jsonb_typeof(node_tree.node -> 'id') = 'string'
)
INSERT INTO pnode (
    id,
    created_at,
    updated_at,
    user_id,
    project_id,
    text,
    parent_pnode_id,
    sort_order,
    position_x,
    position_y
)
SELECT
    node_tree.node ->> 'id',
    node_tree.created_at,
    node_tree.updated_at,
    node_tree.user_id,
    node_tree.project_id,
    node_tree.node ->> 'text',
    node_tree.parent_pnode_id,
    node_tree.sort_order,
    CASE
        WHEN jsonb_typeof(node_tree.node #> '{position,x}') = 'number'
            THEN (node_tree.node #>> '{position,x}')::DOUBLE PRECISION
    END,
    CASE
        WHEN jsonb_typeof(node_tree.node #> '{position,y}') = 'number'
            THEN (node_tree.node #>> '{position,y}')::DOUBLE PRECISION
    END
FROM node_tree
WHERE jsonb_typeof(node_tree.node) = 'object'
  AND jsonb_typeof(node_tree.node -> 'id') = 'string'
  AND jsonb_typeof(node_tree.node -> 'text') = 'string'
ORDER BY node_tree.depth, node_tree.project_id, node_tree.node ->> 'id';

UPDATE project
SET
    view_left = CASE
        WHEN jsonb_typeof(state #> '{view,left}') = 'number'
            THEN (state #>> '{view,left}')::DOUBLE PRECISION
        ELSE 0
    END,
    view_top = CASE
        WHEN jsonb_typeof(state #> '{view,top}') = 'number'
            THEN (state #>> '{view,top}')::DOUBLE PRECISION
        ELSE 0
    END,
    view_zoom = CASE
        WHEN jsonb_typeof(state #> '{view,zoom}') = 'number'
            THEN (state #>> '{view,zoom}')::DOUBLE PRECISION
        ELSE 1
    END,
    anchor_pnode_id = CASE
        WHEN jsonb_typeof(state #> '{anchor,id}') = 'string'
            THEN state #>> '{anchor,id}'
    END,
    anchor_center_y = CASE
        WHEN jsonb_typeof(state #> '{anchor,centerY}') = 'number'
            THEN (state #>> '{anchor,centerY}')::DOUBLE PRECISION
    END;

ALTER TABLE project DROP COLUMN state;
