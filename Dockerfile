FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11, ffmpeg, tesseract (all language packs), and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    ffmpeg \
    curl \
    jq \
    coreutils \
    tesseract-ocr \
    tesseract-ocr-all \
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
COPY app.py .
COPY templates/ templates/

# Create directories for config and data
RUN mkdir -p /config /watch

# Expose web UI port
EXPOSE 5000

# Health check — hits the stats API endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:5000/api/stats || exit 1

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
