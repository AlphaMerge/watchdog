# The pinned Node toolchain: build, test and lint, and the two services in development.
#
# node:24-bookworm plus the handful of system binaries the product actually shells out to.
# ADR-001 makes the system `ping` binary the default ICMP path, so a toolchain without it
# cannot run or test the sensor that uses it (TASKS.md P-16, found while standing up the
# development target — the image had no `ping` at all).
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iputils-ping \
      iproute2 \
 && rm -rf /var/lib/apt/lists/*

# PowerShell, for the same reason as `ping` above: the product shells out to it, so a toolchain
# without it cannot test the sensor that uses it (`P-51`).
#
# `windows-transport.test.ts` gates its real-PowerShell suite on finding a `pwsh` and says it
# "runs wherever a pwsh exists so that never happens again silently" — the failure it names is a
# wrapper that ran nothing at all and exited 0. Without one in the image that suite skipped on
# every machine this project has, so the four `windows.*` sensor types were verified only against
# a fake serialiser. This is the last suite that skipped after every compose dependency was up.
#
# The tarball rather than Microsoft's apt repository, because that repository has no `arm64`
# component for bookworm and half the developers here are on Apple silicon. Extracting the
# official archive is what Microsoft documents for arm64, and it is the same binary either way.
ARG PWSH_VERSION=7.4.6
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      arm64) pwsh_arch='linux-arm64' ;; \
      amd64) pwsh_arch='linux-x64' ;; \
      *) echo "no PowerShell build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/pwsh.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-${pwsh_arch}.tar.gz"; \
    mkdir -p /opt/microsoft/powershell/7; \
    tar -xzf /tmp/pwsh.tar.gz -C /opt/microsoft/powershell/7; \
    rm /tmp/pwsh.tar.gz; \
    chmod +x /opt/microsoft/powershell/7/pwsh; \
    ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh; \
    pwsh --version
