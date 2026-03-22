FROM nvidia/cuda:12.3.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11, ffmpeg (with NVENC support via CUDA), and utilities
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
