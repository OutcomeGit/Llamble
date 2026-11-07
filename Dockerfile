# Llamble server image: Rust API + bundled web client + ffmpeg (video thumbnails)
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY client/package.json client/package-lock.json ./
RUN npm ci --ignore-scripts
COPY client/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/target/release/llamble-server /usr/local/bin/llamble-server
COPY --from=web /web/dist /app/web
ENV LLAMBLE_DATA=/data LLAMBLE_WEB_DIR=/app/web LLAMBLE_BIND=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
CMD ["llamble-server"]
