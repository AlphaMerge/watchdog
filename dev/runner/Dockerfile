# Self-hosted GitHub Actions runner for this repository (`P-198`).
#
# **This installation uses local runners only.** The hosted ones cannot start while the account's
# Actions spending limit is unpaid — every job fails in two seconds with zero steps, which is a red
# cross nobody can act on rather than a signal — so the workflow targets `self-hosted` and this is
# what answers to it.
#
# `ghcr.io/actions/actions-runner` ships the agent and almost nothing else. Everything added below
# is something one of this repository's jobs turned out to need; keep it that way rather than
# pulling in build-essential's world "just in case".
#
# **The Docker CLI is the load-bearing addition.** Every Linux job here shells out to Docker:
# `scripts/dev.sh` runs the toolchain through compose, and both smoke tests boot privileged
# systemd containers. The daemon is the *host's*, reached through a mounted socket — this image
# holds the client only, and nothing here runs a second daemon.
#
# Node is deliberately absent: the jobs use `actions/setup-node`, which fetches the version they
# ask for into the runner's tool cache.
#
# Build and register with `scripts/dev-runner.sh`.
FROM ghcr.io/actions/actions-runner:latest

USER root

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      # `npm ci` compiles argon2 and ssh2's optional native halves from source.
      build-essential \
      python3 \
      # The tarball the packaging step produces, and what the smoke tests unpack.
      tar \
      gzip \
      # `.deb` and `.rpm` are built on this box by `scripts/package.sh`.
      dpkg-dev \
      fakeroot \
      rpm \
      # `wixl` builds the Windows MSI from the same staged tree as everything else (`H-06`).
      msitools \
      # jq is used by several steps to read JSON out of the API.
      jq \
      # **`ping`, because it is the product's default ICMP path** (`CLAUDE.md`), not a test
      # convenience: `icmp.ping` and `icmp.jitter` shell out to the system binary and say so when
      # it is missing. Hosted images happen to carry it; this one has to ask. Seven tests failed
      # on the first local run for want of it.
      iputils-ping \
      # `shellcheck` is a build step of its own over scripts/ and deploy/.
      shellcheck \
    && rm -rf /var/lib/apt/lists/*

# The Docker client and the compose plugin, from Docker's own repository so the two stay in step
# with each other. No daemon: `/var/run/docker.sock` is bind-mounted from the host, which is what
# makes a container full of privileged systemd boxes possible at all from in here.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
         docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# **The runner has to be able to use that socket.** On this host it is owned by root and group
# `docker`; inside the image the agent runs as `runner`. Adding the user to a group whose gid may
# differ from the host's is not enough on its own, so `dev-runner.sh` passes the host socket's gid
# in and the entrypoint reconciles it — the group is created here so there is something to align.
RUN groupadd -f docker && usermod -aG docker runner

USER runner
