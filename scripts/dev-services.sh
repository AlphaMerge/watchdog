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
#
# Prerequisites: npm run dev (for PostgreSQL), scripts/dev.sh npm run build, scripts/dev-certs.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker-compose.dev.yml"
name="ms-server"

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

  start)
    if [ ! -f "${repo_root}/dev/tls/core.crt" ]; then
      echo "no development certificates; run scripts/dev-certs.sh first" >&2
      exit 1
    fi
    if [ ! -f "${repo_root}/packages/core/dist/src/main.js" ]; then
      echo "nothing built; run scripts/dev.sh 'npm run build' first" >&2
      exit 1
    fi

    docker rm -f "${name}" >/dev/null 2>&1 || true

    # MS_API__HOST overrides the config file's 127.0.0.1: inside a container that would bind
    # the container's own loopback, and no published port could reach it.
    # MS_LOG_LEVEL=debug is how you see individual checks finishing: the probe logs each one at
    # debug, because at 5,000 sensors a minute an info line per check is the whole journal.
    # 10162/udp is the probe's SNMP trap listener (T-06) and 10514 is T-20's syslog listener,
    # published so a sender on the host or in another compose service can reach them — 162 and
    # 514 themselves need privilege the dev probe has not got. Syslog is published twice because
    # it listens on both transports on the same port, which is what a syslog receiver is.
    docker compose -f "${compose_file}" run -d --name "${name}" \
      -e MS_API__HOST=0.0.0.0 \
      -e "MS_SERVICE__LOG_LEVEL=${MS_LOG_LEVEL:-info}" \
      -p 127.0.0.1:8080:8080 \
      -p 127.0.0.1:10162:10162/udp \
      -p 127.0.0.1:10514:10514/udp \
      -p 127.0.0.1:10514:10514 \
      toolchain \
      'node packages/core/dist/src/main.js --config dev/core.json & sleep 3; exec node packages/probe/dist/src/main.js --config dev/probe.json' \
      >/dev/null

    echo "started ${name}"
    echo "  API   http://127.0.0.1:8080/api/v1/objects/root"
    echo "  logs  scripts/dev-services.sh logs -f"
    ;;

  *)
    echo "usage: $(basename "${BASH_SOURCE[0]}") [start|stop|restart|logs]" >&2
    exit 2
    ;;
esac
