# Build from the repository root: docker build -t mindgrab .
# The Rust API. The webapp is a separate image: webapp/Dockerfile.
# Railway requires cache IDs prefixed with the service ID (s/<service-id>-).
FROM rust:1.96.0-bookworm AS rust
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY backend ./backend
COPY tooling ./tooling
RUN --mount=type=cache,id=s/bccf447e-2320-404e-8364-11b5fd92a340-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s/bccf447e-2320-404e-8364-11b5fd92a340-/app/target,target=/app/target \
    cargo build --locked --release -p mindgrab-backend \
    && cp target/release/mindgrab-backend /usr/local/bin/mindgrab-backend

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/bin/mindgrab-backend /usr/local/bin/mindgrab-backend
ENV HOST=:: PORT=8080 RUST_LOG=info
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/mindgrab-backend"]
