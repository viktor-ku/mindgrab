# Build from the repository root: docker build -f webapp/Dockerfile .
# Static webapp for the Railway `web` service.
# Railway requires cache IDs prefixed with the service ID (s/<service-id>-).
FROM rust:1.96.0-bookworm AS state
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,id=s/fc35494c-085f-46fa-902b-f85663912434-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY backend ./backend
COPY tooling ./tooling
RUN --mount=type=cache,id=s/fc35494c-085f-46fa-902b-f85663912434-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s/fc35494c-085f-46fa-902b-f85663912434-/app/target,target=/app/target \
    cargo build --locked -p mindgrab-state --target wasm32-unknown-unknown --release \
    && mkdir -p /bindings \
    && wasm-bindgen --target web --out-dir /bindings --out-name mindgrab_state \
        target/wasm32-unknown-unknown/release/mindgrab_state.wasm \
    && cargo run --locked --quiet -p mindgrab-state --features bindings \
        --example generate_types > /bindings/model.ts

FROM oven/bun:1.4.2 AS webapp
# Uploads source maps to PostHog error tracking (Railway builds on x86_64).
ADD --checksum=sha256:5227b8e00a463ea42e09cd77e2f8cfd9bf6f4c4af6fbe0d2522fcd0dc99b93f5 \
    https://github.com/PostHog/posthog/releases/download/posthog-cli/v0.19.0/posthog-cli-x86_64-unknown-linux-musl.tar.gz \
    /tmp/posthog-cli.tar.gz
RUN tar -xzf /tmp/posthog-cli.tar.gz -C /usr/local/bin --strip-components=1 \
        posthog-cli-x86_64-unknown-linux-musl/posthog-cli \
    && rm /tmp/posthog-cli.tar.gz
WORKDIR /app
COPY package.json bun.lock ./
COPY webapp/package.json ./webapp/package.json
COPY e2e/package.json ./e2e/package.json
RUN bun --bun install --frozen-lockfile --filter mindgrab
COPY webapp ./webapp
COPY --from=state /bindings ./webapp/src/generated/mindgrab-state
ARG VITE_BACKEND_URL
ARG VITE_POSTHOG_KEY
# A PostHog personal API key with error tracking write access. Without it the
# build skips the upload. A failed upload never blocks a deploy.
ARG POSTHOG_CLI_API_KEY
ARG POSTHOG_CLI_PROJECT_ID=336571
# Provided by Railway; names the release that exceptions are grouped under.
ARG RAILWAY_GIT_COMMIT_SHA
RUN bun --bun run --cwd webapp build \
    && if [ -n "$POSTHOG_CLI_API_KEY" ]; then \
        POSTHOG_CLI_API_KEY="$POSTHOG_CLI_API_KEY" \
        POSTHOG_CLI_PROJECT_ID="$POSTHOG_CLI_PROJECT_ID" \
        posthog-cli --host https://eu.posthog.com --no-fail sourcemap process \
            --directory webapp/dist --release-name mindgrab-webapp \
            ${RAILWAY_GIT_COMMIT_SHA:+--release-version "$RAILWAY_GIT_COMMIT_SHA"}; \
    fi \
    && find webapp/dist -name '*.map' -delete

FROM caddy:2.11.8-alpine
COPY webapp/Caddyfile /etc/caddy/Caddyfile
COPY --from=webapp /app/webapp/dist /srv
ENV PORT=8080
EXPOSE 8080
USER 65532:65532
