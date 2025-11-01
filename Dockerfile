FROM python:3.11-alpine

# Install system dependencies
RUN apk add --no-cache \
    ffmpeg \
    curl \
    jq \
    coreutils \
    bash

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

# Set environment variables with defaults
ENV WATCH_DIR=/watch \
    CONFIG_FILE=/config/config.json \
    DB_FILE=/config/processed.db \
    PORT=5000 \
    MAX_WORKERS=4 \
    STABILIZE_INTERVAL=10 \
    STABILIZE_CHECKS=3

# Run the application
CMD ["python", "app.py"]
