# Build from the repository root: docker build -f backend/Dockerfile .
FROM rust:1.96.0-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY backend ./backend
COPY tooling ./tooling
RUN --mount=type=cache,id=s/d4ffc360-fb9e-4a60-a8c1-e3624f166c8b-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s/d4ffc360-fb9e-4a60-a8c1-e3624f166c8b-/app/target,target=/app/target \
    cargo build --locked --release -p mindgrab-backend \
    && cp target/release/mindgrab-backend /usr/local/bin/mindgrab-backend

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/mindgrab-backend /usr/local/bin/mindgrab-backend
ENV HOST=:: PORT=3000 RUST_LOG=info
EXPOSE 3000
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/mindgrab-backend"]
