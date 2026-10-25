#!/usr/bin/env sh
# Builds the skill-runner image that sandbox-broker starts. Compose cannot build an image that no
# service runs, so run this on the Docker host before the first deploy and after each change.
# Usage: scripts/build-skill-runner.sh [tag]   (default tag: latest)
set -eu
cd "$(dirname "$0")/.."
docker build -f infra/Dockerfile.skill-runner -t "pa-skill-runner:${1:-latest}" .
