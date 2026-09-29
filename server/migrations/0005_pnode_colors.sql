ALTER TABLE pnode
    ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'
    CHECK (color IN ('blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet', 'slate'));
