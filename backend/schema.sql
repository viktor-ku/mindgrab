-- Loro document storage and authenticated cloud ownership.
CREATE SCHEMA IF NOT EXISTS mindgrab_loro;
CREATE TABLE IF NOT EXISTS mindgrab_loro.users (
    id BIGSERIAL PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mindgrab_loro.login_attempts (
    state_hash TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS mindgrab_loro.sessions (
    browser_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES mindgrab_loro.users(id),
    provider_session TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON mindgrab_loro.sessions(expires_at);
-- While set and in the future, one request is refreshing this session's tokens.
ALTER TABLE mindgrab_loro.sessions ADD COLUMN IF NOT EXISTS refreshing_until TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS mindgrab_loro.projects (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES mindgrab_loro.users(id),
    name TEXT,
    snapshot BYTEA,
    revision BIGINT NOT NULL DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner ON mindgrab_loro.projects(owner_id,id) WHERE NOT deleted;
-- A project's "anyone with the link can view" token. NULL keeps it private.
ALTER TABLE mindgrab_loro.projects ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;
-- What share link viewers load: the map at `shared_revision` without its edit
-- history, which keeps deleted ideas and notes. Built when first viewed.
ALTER TABLE mindgrab_loro.projects ADD COLUMN IF NOT EXISTS shared_snapshot BYTEA;
ALTER TABLE mindgrab_loro.projects ADD COLUMN IF NOT EXISTS shared_revision BIGINT;
-- How each account wants Mindgrab to work: how its maps look, where they are
-- saved, and its answer about analytics. A preference is set for all of the
-- account's maps (global) or for one map, whose own value wins. Rust checks
-- every value against its name, and which scopes it allows, before it is
-- stored.
DO $$ BEGIN
    CREATE TYPE mindgrab_loro.preference_scope AS ENUM ('global', 'map');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE TYPE mindgrab_loro.preference_name AS ENUM (
        'quick_colors', 'new_idea_color', 'link_style',
        'save_locally', 'save_in_cloud', 'analytics_consent'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS mindgrab_loro.preferences (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES mindgrab_loro.users(id),
    scope mindgrab_loro.preference_scope NOT NULL,
    -- The map a map preference is for. Not a reference to projects: a map
    -- saved only in the browser has no row there, and its preferences still
    -- follow the account.
    project_id UUID,
    name mindgrab_loro.preference_name NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'map') = (project_id IS NOT NULL)),
    UNIQUE NULLS NOT DISTINCT (user_id, scope, project_id, name)
);
