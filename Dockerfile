# ── Frontend build stage ───────────────────────────────────────────────────
# The dashboard is a pure client-side Next.js SPA (no SSR) exported as static
# files and served directly by Flask below — this is the only stage that
# needs Node; it isn't present in the final image.
FROM node:22-slim AS frontend-build
WORKDIR /frontend
ENV CI=true
RUN npm install -g pnpm@11
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── Backend / runtime image ─────────────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11, ffmpeg, tesseract (all language packs), and utilities.
# Disc-image tooling:
#   lsdvd          — enumerate DVD titles/tracks straight from an .iso
#   dvdbackup      — extract the main-title VOBs for ripping (CSS-decrypted)
#   libarchive-tools — bsdtar, used to peek at an ISO's top-level dirs
#   libdvd-pkg     — builds/installs libdvdcss2 so CSS-protected DVDs are readable
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    ffmpeg \
    curl \
    jq \
    coreutils \
    tesseract-ocr \
    tesseract-ocr-all \
    fonts-noto-core \
    fonts-noto-cjk \
    lsdvd \
    dvdbackup \
    libarchive-tools \
    libdvd-pkg \
    build-essential \
    fakeroot \
    wget \
    && dpkg-reconfigure -f noninteractive libdvd-pkg \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files. Strip CR in case the script was checked out
# on Windows with autocrlf — otherwise the kernel tries to load
# /bin/bash\r as the interpreter and the container exits immediately.
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
COPY app.py anime_subtitles.py pgs_subtitles.py .
COPY frontend/lib/data/iso-639-2.json languages.json

# Static frontend build — served directly by Flask (see STATIC_DIR in app.py)
COPY --from=frontend-build /frontend/out/ static/

# Create directories for config and data
RUN mkdir -p /config /watch

# Expose web UI port
EXPOSE 5000

# Health check — unauthenticated, lightweight DB ping
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:5000/api/health || exit 1

# The NVIDIA Container Toolkit injects libnvidia-encode.so.1 and
# libnvcuvid.so.1 from the host driver into /usr/lib/x86_64-linux-gnu
# at container startup. That path is already in ldconfig's default
# search, so no extra LD_LIBRARY_PATH is needed.
# DO NOT install libnvidia-encode from the CUDA apt repo — it pulls in
# cuda-compat which breaks cuInit on Pascal GPUs (GTX 10xx and older)
# with CUDA_ERROR_COMPAT_NOT_SUPPORTED_ON_DEVICE.

# Set environment variables with defaults
ENV WATCH_DIR=/watch \
    CONFIG_FILE=/config/config.json \
    DB_FILE=/config/processed.db \
    PORT=5000 \
    MAX_WORKERS=4 \
    STABILIZE_INTERVAL=10 \
    STABILIZE_CHECKS=3 \
    REENCODE_SIZE_GB=20 \
    PYTHONUNBUFFERED=1

# entrypoint runs ldconfig to pick up NVIDIA libs injected at runtime,
# then execs the CMD
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-u", "app.py"]
