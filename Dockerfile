# Build from the repository root: docker build -t mindgrab .
# One image: the Rust backend serves the API and the built webapp.
# Railway requires cache IDs prefixed with the service ID (s/<service-id>-).
FROM rust:1.96.0-bookworm AS rust
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,id=s/bccf447e-2320-404e-8364-11b5fd92a340-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY backend ./backend
COPY tooling ./tooling
RUN --mount=type=cache,id=s/bccf447e-2320-404e-8364-11b5fd92a340-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s/bccf447e-2320-404e-8364-11b5fd92a340-/app/target,target=/app/target \
    cargo build --locked --release -p mindgrab-backend \
    && cp target/release/mindgrab-backend /usr/local/bin/mindgrab-backend \
    && cargo build --locked -p mindgrab-state --target wasm32-unknown-unknown --release \
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
COPY --from=rust /bindings ./webapp/src/generated/mindgrab-state
ARG VITE_POSTHOG_KEY
RUN bun --bun run --cwd webapp build

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/bin/mindgrab-backend /usr/local/bin/mindgrab-backend
COPY --from=webapp /app/webapp/dist /srv/webapp
ENV HOST=:: PORT=3000 RUST_LOG=info WEBAPP_DIST=/srv/webapp
EXPOSE 3000
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/mindgrab-backend"]
