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
