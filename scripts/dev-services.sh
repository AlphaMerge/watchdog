#!/usr/bin/env bash
# Run ms-core and ms-probe for development, in the pinned toolchain container.
#
# Development only. Production runs them as native services under systemd or WinSW.
#
# Both share one container because dev/probe.json dials the core on 127.0.0.1 — the probe
# endpoint is not published, and a development probe has no business being reachable from
# anywhere else. The API *is* published, on loopback, so a browser can reach it.
#
#   scripts/dev-services.sh start    # or no argument
#   scripts/dev-services.sh stop
#   scripts/dev-services.sh logs [-f]
#   scripts/dev-services.sh restart
#   scripts/dev-services.sh build    # what start does first
#
# Prerequisites: npm run dev (for PostgreSQL), scripts/dev-certs.sh
#
# **It runs its own build of origin/main, never the checkout's** (`H-24`). The core migrates the
# shared development database on every start, and run from the checkout's `dist` it applied
# whatever migration a session had built and not yet landed. One such draft, edited before it
# landed, left every later start refusing (`P-238`). `start` builds origin/main, as this clone
# last fetched it, into the `ms-server-build` volume when it has moved, and runs that. Its data,
# certificates and vault key are still the checkout's `dev/`. `MS_SERVER_REF` builds another ref
# — for trying a change to these scripts, and never for a migration that has not landed.
#
# The container restarts with Docker (`unless-stopped`), so after a Docker Desktop restart or a
# reboot the UI on :5173 has a core behind it again. `stop` removes the container, so a stopped
# ms-server stays stopped — which is what a test:perf run needs.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker-compose.dev.yml"
name="ms-server"

# What runs inside the container — ms-core and ms-probe, and an exit when either stops — is
# `scripts/lib/ms-server-supervisor.sh`, which says why it is shaped the way it is. `exec`, so the
# supervisor is the process `docker stop` signals rather than a shell in front of it.
supervisor='exec bash scripts/lib/ms-server-supervisor.sh'
build_volume="ms-server-build"

case "${1:-start}" in
  stop)
    docker rm -f "${name}" >/dev/null 2>&1 || true
    echo "stopped ${name}"
    ;;

  logs)
    shift || true
    exec docker logs "$@" "${name}"
    ;;

  restart)
    "${BASH_SOURCE[0]}" stop
    "${BASH_SOURCE[0]}" start
    ;;

  build)
    ref="${MS_SERVER_REF:-origin/main}"
    commit="$(git -C "${repo_root}" rev-parse --verify "${ref}^{commit}")"
    # The tree as committed, so nothing uncommitted in the checkout reaches it.
    git -C "${repo_root}" archive --format=tar "${commit}" |
      docker compose -f "${compose_file}" run --rm -T -v "${build_volume}:/ms-server" toolchain \
        'exec bash scripts/lib/ms-server-build.sh "$1"' ms-server-build "${commit}"
    ;;

  start)
    if [ ! -f "${repo_root}/dev/tls/core.crt" ]; then
      echo "no development certificates; run scripts/dev-certs.sh first" >&2
      exit 1
    fi
    "${BASH_SOURCE[0]}" build

    docker rm -f "${name}" >/dev/null 2>&1 || true

    # MS_API__HOST overrides the config file's 127.0.0.1: inside a container that would bind
    # the container's own loopback, and no published port could reach it.
    # MS_LOG_LEVEL=debug is how you see individual checks finishing: the probe logs each one at
    # debug, because at 5,000 sensors a minute an info line per check is the whole journal.
    # 10162/udp is the probe's SNMP trap listener (T-06) and 10514 is T-20's syslog listener,
    # published so a sender on the host or in another compose service can reach them — 162 and
    # 514 themselves need privilege the dev probe has not got. Syslog is published twice because
    # it listens on both transports on the same port, which is what a syslog receiver is.
    # MS_DATABASE__AUTO_MIGRATE because `dev/core.json` turns it off, for every core run by hand
    # from a checkout: one of those refuses a migration it has not landed rather than applying it.
    docker compose -f "${compose_file}" run -d --name "${name}" \
      -v "${build_volume}:/ms-server" \
      -e MS_SERVER_BUILD=/ms-server \
      -e MS_DATABASE__AUTO_MIGRATE=true \
      -e MS_API__HOST=0.0.0.0 \
      -e "MS_SERVICE__LOG_LEVEL=${MS_LOG_LEVEL:-info}" \
      -p 127.0.0.1:8080:8080 \
      -p 127.0.0.1:10162:10162/udp \
      -p 127.0.0.1:10514:10514/udp \
      -p 127.0.0.1:10514:10514 \
      toolchain \
      "${supervisor}" \
      >/dev/null

    # `compose run` has no --restart flag; the policy is set on the container it created.
    docker update --restart unless-stopped "${name}" >/dev/null

    echo "started ${name}"
    echo "  API   http://127.0.0.1:8080/api/v1/objects/root"
    echo "  logs  scripts/dev-services.sh logs -f"
    ;;

  *)
    echo "usage: $(basename "${BASH_SOURCE[0]}") [start|stop|restart|logs|build]" >&2
    exit 2
    ;;
esac
