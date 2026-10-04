# Clean-box install target for the packaging smoke test (TASKS.md F-08).
#
# Development/CI only — this image exists to prove install.sh works against a real systemd,
# it is not a way to run MonitoringSystem in a container.
FROM debian:bookworm

ARG NODE_VERSION=24.19.0

# PostgreSQL is here because ms-core genuinely needs it from Phase 1 onward. An install test
# against a box with no database would only prove that the service exits cleanly.
# `iputils-ping` because every Debian host has it and the container image does not; the tarball
# installers refuse without one (H-31). smoke-packages.sh removes it again, so that the .deb's
# dependency is what brings it back.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus ca-certificates curl gnupg lsb-release xz-utils procps \
      iputils-ping postgresql postgresql-contrib \
 && rm -rf /var/lib/apt/lists/*

# TimescaleDB, from Timescale's own repository — the same way an operator installs it. Without
# it the install test would prove only that migration 003 fails politely, which is a different
# thing from proving the product installs.
RUN set -eux; \
    . /etc/os-release; \
    pg_major="$(pg_config --version | sed 's/PostgreSQL \([0-9]*\).*/\1/')"; \
    echo "deb https://packagecloud.io/timescale/timescaledb/debian/ ${VERSION_CODENAME} main" \
      > /etc/apt/sources.list.d/timescaledb.list; \
    curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey \
      | gpg --dearmor > /etc/apt/trusted.gpg.d/timescaledb.gpg; \
    apt-get update; \
    apt-get install -y --no-install-recommends "timescaledb-2-postgresql-${pg_major}"; \
    rm -rf /var/lib/apt/lists/*

# Node from the official tarball: the same way an operator installs it, no distro packaging.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    rm /tmp/node.tar.xz; \
    node --version

# Trim units that are pointless in a container and slow the boot.
RUN systemctl mask systemd-udevd systemd-udev-trigger systemd-firstboot \
      systemd-journald-audit.socket getty.target

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
