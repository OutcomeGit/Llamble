# Llamble server image: Rust API + web client + bundled llama.cpp (llama-server) + LiveKit (voice) + ffmpeg
# The same image also runs as a relay on a VPS: `llamble-server relay`
FROM node:22-bookworm-slim AS web
ARG LLAMBLE_VERSION=0.0.0
WORKDIR /web
COPY client/package.json client/package-lock.json ./
RUN npm ci --ignore-scripts
COPY client/ ./
RUN npm version "$LLAMBLE_VERSION" --no-git-tag-version --allow-same-version >/dev/null && npm run build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# llama.cpp's official CPU server build (binary + its shared libs live in /app)
FROM ghcr.io/ggml-org/llama.cpp:server AS llama

# LiveKit voice/video server (single static binary), run and configured by Llamble itself
FROM livekit/livekit-server:latest AS livekit

# sherpa-onnx: speech recognition (Whisper) and natural speech (Kokoro) for "Hey Llamble",
# all on the CPU. Only the two tools we use; models are downloaded when it's turned on.
FROM ubuntu:24.04 AS sherpa
ARG SHERPA_VERSION=1.12.9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
    && curl -fsSL "https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared.tar.bz2" | tar xj -C /tmp \
    && mkdir -p /opt/sherpa/bin \
    && mv /tmp/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared/lib /opt/sherpa/lib \
    && mv /tmp/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared/bin/sherpa-onnx-offline /tmp/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared/bin/sherpa-onnx-offline-tts /opt/sherpa/bin/

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 curl bzip2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=llama /app /opt/llama
COPY --from=livekit /livekit-server /opt/livekit/livekit-server
COPY --from=sherpa /opt/sherpa /opt/sherpa
COPY --from=server /src/target/release/llamble-server /usr/local/bin/llamble-server
COPY --from=web /web/dist /app/web
ARG LLAMBLE_VERSION=0.0.0
ENV LLAMBLE_VERSION=$LLAMBLE_VERSION
ENV LD_LIBRARY_PATH=/opt/llama:/opt/sherpa/lib \
    LLAMBLE_LLAMA_BIN=/opt/llama/llama-server \
    LLAMBLE_DATA=/data LLAMBLE_WEB_DIR=/app/web LLAMBLE_BIND=0.0.0.0:8080
# fail the image build if llama-server can't run here (missing libs etc.)
RUN /opt/llama/llama-server --version && /opt/livekit/livekit-server --version \
    && ! ldd /opt/sherpa/bin/sherpa-onnx-offline /opt/sherpa/bin/sherpa-onnx-offline-tts | grep -q "not found"
# Run as TrueNAS's "apps" user (568). The data dir is pre-owned by it, so a fresh
# Docker-managed volume mounted at /data inherits that ownership automatically.
RUN mkdir -p /data && chown 568:568 /data
USER 568:568
VOLUME /data
EXPOSE 8080 8443 7881 7882/udp
CMD ["llamble-server"]
