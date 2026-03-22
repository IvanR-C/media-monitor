FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11, ffmpeg, and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    ffmpeg \
    curl \
    jq \
    coreutils \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Install libnvidia-encode from NVIDIA's apt repo so hevc_nvenc works
# without needing the library to be present on the host or injected by
# the Container Toolkit. Pinned to 550 — update if host driver changes.
RUN curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb \
        -o /tmp/cuda-keyring.deb \
    && dpkg -i /tmp/cuda-keyring.deb \
    && rm /tmp/cuda-keyring.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends libnvidia-encode-550 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app.py .
COPY templates/ templates/

# Create directories for config and data
RUN mkdir -p /config /watch

# Expose web UI port
EXPOSE 5000

# Health check — hits the stats API endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:5000/api/stats || exit 1

# Expose NVIDIA Container Toolkit's injected driver libs to ffmpeg.
# The toolkit mounts libnvidia-encode.so.1 and friends into
# /usr/local/nvidia/lib64 at container startup but doesn't add that
# path to ldconfig, so ffmpeg can't find them without this.
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/lib/x86_64-linux-gnu

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

# Run the application (-u = unbuffered stdout/stderr, same as PYTHONUNBUFFERED=1)
CMD ["python", "-u", "app.py"]
