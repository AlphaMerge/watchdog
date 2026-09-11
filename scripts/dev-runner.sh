#!/usr/bin/env bash
# Runs the self-hosted GitHub Actions runner for AlphaMerge/watchdog in a container on this Mac.
#
# **This installation uses local runners only.** GitHub-hosted jobs cannot start while the
# account's Actions spending limit is unpaid — they fail in two seconds with zero steps, which is
# a red cross nobody can act on rather than a signal — so `ci.yml` targets `self-hosted` and this
# is what answers to it.
#
# Usage:
#   scripts/dev-runner.sh                 # mint a token with gh, build, register, start
#   RUNNER_COUNT=2 scripts/dev-runner.sh  # two runners, so two jobs run at once
#   RUNNER_TOKEN=<token> scripts/dev-runner.sh   # a token you minted yourself
#
# One runner process takes exactly ONE job at a time — there is no concurrency setting on a
# runner — so the count here IS the pipeline's parallelism. `install-smoke` and `enrol-smoke` both
# boot privileged systemd boxes and each takes several minutes, so two is the useful number on a
# laptop; more will contend for the same Docker daemon rather than going faster.
#
# They stay up and take jobs until stopped:
#   docker stop watchdog-runner-1     # pause; restart with `docker start`
#   docker rm -f watchdog-runner-1    # discard; re-running this script registers it again
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=AlphaMerge/watchdog
PREFIX=watchdog-runner
IMAGE=watchdog-runner:local
LABEL=watchdog-linux
COUNT=${RUNNER_COUNT:-1}

# **Each runner's work directory is bind-mounted at the same path inside and out, and that is not
# a style choice.** `docker-compose.dev.yml` mounts `.:/workspace`, so when a job runs `scripts/dev.sh`
# the *host's* Docker is asked to bind-mount the job's checkout — by the path the job sees. With
# the usual `/home/runner/_work` that path does not exist on the host and compose silently mounts
# an empty directory, which surfaces as a toolchain container with no source in it.
WORK=${RUNNER_WORK_DIR:-$HOME/watchdog-runner-work}

echo "==> building $IMAGE"
docker build -q -f "${repo_root}/dev/runner/Dockerfile" -t "$IMAGE" "${repo_root}/dev/runner" >/dev/null

# A registration token, not a PAT: it is scoped to adding a runner to this one repository and
# expires in an hour. Each runner then holds credentials of its own and does not need it again
# unless its container is recreated.
if [ -z "${RUNNER_TOKEN:-}" ]; then
  echo "==> minting a registration token"
  RUNNER_TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
fi
[ -n "${RUNNER_TOKEN}" ] || { echo "no registration token — are you an admin on ${REPO}?" >&2; exit 1; }

# **`+`, not `\+`.** Docker's name filter is a Go RE2 pattern, where `\+` is an escaped literal
# plus rather than "one or more" — so the version this was inherited with matched nothing at all,
# and re-running the script failed on a name conflict instead of replacing the pool. Removing a
# container does not deregister the runner: GitHub keeps showing it offline until `--replace`
# below takes its name back, which is why the names are stable rather than random.
for stale in $(docker ps -aq --filter "name=^${PREFIX}-[0-9]+$"); do
  docker rm -f "$stale" >/dev/null 2>&1 || true
done

for i in $(seq "$COUNT"); do
  # **One work directory per runner, not one for the pool** (`P-201`). A runner derives its
  # checkout path from `--work`, so two agents sharing it would hand two concurrent jobs the same
  # directory: `install-smoke` and `enrol-smoke` both wait on `build` and become runnable
  # together, and they would then clean the tree under each other and stage into one `build/`.
  # What either reported afterwards would be a packaging failure, which is exactly what those
  # jobs exist to find — so the false one would look like the real thing.
  work="${WORK}-${i}"
  mkdir -p "${work}"

  # --group-add 0: the mounted socket is root:root inside Docker Desktop's VM, and the image's
  #   `runner` user is not in a group that matches — group 0 is what actually grants access.
  # --restart on-failure:2, not unless-stopped: registration happens inside this same command, so
  #   a stale or wrong-repo token would otherwise restart-loop for ever and bury its own error.
  # --name must be unique per runner, or each registration evicts the last with --replace and the
  #   pool silently stays at one. The LABEL is shared: that is what `ci.yml` matches on.
  docker run -d \
    --name "${PREFIX}-${i}" \
    --restart on-failure:2 \
    --group-add 0 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${work}:${work}" \
    --add-host host.docker.internal:host-gateway \
    -e ImageOS=ubuntu24 \
    --entrypoint bash \
    "$IMAGE" -c "./config.sh \
        --url 'https://github.com/${REPO}' \
        --token '${RUNNER_TOKEN}' \
        --name '${PREFIX}-${i}' \
        --labels self-hosted,linux,${LABEL} \
        --work '${work}' \
        --unattended --replace \
     && ./run.sh"
done

echo "$COUNT runner(s) starting; follow one with:"
echo "  docker logs -f ${PREFIX}-1"
echo "and confirm each reaches 'Listening for Jobs':"
echo "  for i in \$(seq $COUNT); do docker logs ${PREFIX}-\$i 2>&1 | tail -1; done"
