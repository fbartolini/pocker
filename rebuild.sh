#!/bin/bash
set -e
echo "Building Docker image..."
docker build -t pocker .
echo "Build complete. Run with:"
echo "docker run --rm -p 4173:4173 --env-file .env -v /var/run/docker.sock:/var/run/docker.sock:ro -v \$(pwd)/config:/app/config:ro -e PORT=4173 pocker"
