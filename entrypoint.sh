#!/bin/bash
# Refresh ldconfig cache so ffmpeg can find NVIDIA libs injected by
# the Container Toolkit into /usr/lib/x86_64-linux-gnu at container start.
ldconfig
exec "$@"
