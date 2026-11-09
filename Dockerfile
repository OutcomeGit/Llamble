# Llamble server image: Rust API + web client + bundled llama.cpp (llama-server) + LiveKit (voice) + ffmpeg
# The same image also runs as a relay on a VPS: `llamble-server relay`
FROM node:22-trixie-slim AS web
ARG LLAMBLE_VERSION=0.0.0
WORKDIR /web
COPY client/package.json client/package-lock.json ./
RUN npm ci --ignore-scripts
COPY client/ ./
RUN npm version "$LLAMBLE_VERSION" --no-git-tag-version --allow-same-version >/dev/null && npm run build

FROM rust:1-trixie AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
# the Llamble news public key (empty until the project fills it in)
COPY server/news_pubkey.txt ./news_pubkey.txt
RUN touch src/main.rs && cargo build --release

# llama.cpp's official CPU server build (binary + its shared libs live in /app), always current.
# Our runtime below must be at least as new a Linux as theirs; the check at the end of this
# file fails the build if it ever isn't, so we find out in CI, never on the NAS.
FROM ghcr.io/ggml-org/llama.cpp:server AS llama

# LiveKit voice/video server (single static binary), run and configured by Llamble itself
FROM livekit/livekit-server:latest AS livekit

# sherpa-onnx: speech recognition (Whisper) and natural speech (Kokoro) for "Hey Llamble",
# all on the CPU. Only the two tools we use; models are downloaded when it's turned on.
FROM ubuntu:26.04 AS sherpa
ARG SHERPA_VERSION=1.12.9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
    && curl -fsSL "https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared.tar.bz2" | tar xj -C /tmp \
    && mkdir -p /opt/sherpa/bin \
    && mv /tmp/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared/lib /opt/sherpa/lib \
    && mv /tmp/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared/bin/sherpa-onnx-offline /tmp/sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared/bin/sherpa-onnx-offline-tts /opt/sherpa/bin/

# stable-diffusion.cpp: pictures (FLUX.2 klein / Z-Image) on the NAS when no GPU is lent.
# Vulkan uses the NAS's built-in graphics if the container is given /dev/dri; else the CPU.
FROM ubuntu:26.04 AS sdcpp
ARG SD_COMMIT=de00bafc3d473069583752c80a0d56140477ede2
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git cmake libvulkan-dev glslc spirv-headers ca-certificates \
    && git clone https://github.com/leejet/stable-diffusion.cpp /sd && cd /sd && git checkout "$SD_COMMIT" \
    && git submodule update --init --recursive --depth 1
RUN cd /sd && cmake -B build -DSD_VULKAN=ON -DSD_BUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DSD_BUILD_SHARED_GGML_LIB=ON \
      -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DSD_SERVER_BUILD_FRONTEND=OFF -DSD_WEBM=OFF \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN' \
    && cmake --build build --config Release -j"$(nproc)" \
    && mkdir -p /opt/sd && cp -a build/bin/. /opt/sd/ \
    && find build -name 'libggml*.so*' -exec cp -an {} /opt/sd/ \; && ls -la /opt/sd
COPY tools/ggml_check.c /tmp/ggml_check.c
RUN gcc -O1 -o /opt/sd-check /tmp/ggml_check.c -ldl

FROM ubuntu:26.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 curl bzip2 libvulkan1 mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*
COPY --from=llama /app /opt/llama
COPY --from=livekit /livekit-server /opt/livekit/livekit-server
COPY --from=sherpa /opt/sherpa /opt/sherpa
COPY --from=sdcpp /opt/sd /opt/sd
COPY --from=sdcpp /opt/sd-check /usr/local/bin/llamble-sd-check
COPY --from=server /src/target/release/llamble-server /usr/local/bin/llamble-server
COPY --from=web /web/dist /app/web
ARG LLAMBLE_VERSION=0.0.0
ENV LLAMBLE_VERSION=$LLAMBLE_VERSION
ENV LD_LIBRARY_PATH=/opt/llama:/opt/sherpa/lib \
    LLAMBLE_LLAMA_BIN=/opt/llama/llama-server \
    LLAMBLE_DATA=/data LLAMBLE_WEB_DIR=/app/web LLAMBLE_BIND=0.0.0.0:8080
# fail the image build if llama-server can't run here (missing libs etc.)
RUN /opt/llama/llama-server --version && /opt/livekit/livekit-server --version \
    && ! ldd /opt/sherpa/bin/sherpa-onnx-offline /opt/sherpa/bin/sherpa-onnx-offline-tts | grep -q "not found" \
    && ! ldd /opt/sd/sd-cli | grep -q "not found" \
    && LD_LIBRARY_PATH=/opt/sd:$LD_LIBRARY_PATH llamble-sd-check /opt/sd
# Run as TrueNAS's "apps" user (568). The data dir is pre-owned by it, so a fresh
# Docker-managed volume mounted at /data inherits that ownership automatically.
RUN mkdir -p /data && chown 568:568 /data
USER 568:568
# ...and as the user it really runs as
RUN LD_LIBRARY_PATH=/opt/sd:$LD_LIBRARY_PATH llamble-sd-check /opt/sd
VOLUME /data
EXPOSE 8080 8443 7881 7882/udp
CMD ["llamble-server"]
