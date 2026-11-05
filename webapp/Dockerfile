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
WORKDIR /app
COPY package.json bun.lock ./
COPY webapp/package.json ./webapp/package.json
COPY e2e/package.json ./e2e/package.json
RUN bun --bun install --frozen-lockfile --filter mindgrab
COPY webapp ./webapp
COPY --from=state /bindings ./webapp/src/generated/mindgrab-state
ARG VITE_BACKEND_URL
ARG VITE_POSTHOG_KEY
RUN bun --bun run --cwd webapp build

FROM caddy:2.11.8-alpine
COPY webapp/Caddyfile /etc/caddy/Caddyfile
COPY --from=webapp /app/webapp/dist /srv
ENV PORT=8080
EXPOSE 8080
USER 65532:65532
