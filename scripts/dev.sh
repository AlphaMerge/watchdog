#!/usr/bin/env bash
# Run a command in the pinned Node toolchain container.
#
# Development only. Production runs ms-core and ms-probe as native services; this script
# exists so a developer needs nothing on the host but Docker.
#
#   scripts/dev.sh npm install
#   scripts/dev.sh npm run build
#   scripts/dev.sh npm test
#   scripts/dev.sh            # interactive shell
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker-compose.dev.yml"

if [ "$#" -eq 0 ]; then
  exec docker compose -f "${compose_file}" run --rm -it toolchain bash
fi

exec docker compose -f "${compose_file}" run --rm -T toolchain "$*"
