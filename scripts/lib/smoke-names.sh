#!/usr/bin/env bash
# Per-run names for the smoke harnesses' containers (`P-200`).
#
# Source this; it defines functions and sets nothing else.
#
# **Fixed names were free on a hosted runner and are not free now.** Each harness used to name its
# boxes the same on every run — `ms-smoke-core`, `ms-smoke-install-debian` — and remove those
# names at startup and from an `EXIT` trap. On a throwaway machine nothing else could be using
# them. Since `P-198` the machine that runs CI is the machine somebody develops on, so a push and
# a hand-run of the same script overlap whenever they land within a few minutes, and the second
# run's cleanup deletes the first run's boxes *mid-test*. What the first run then reports is a
# probe that stopped answering — which reads exactly like the defect these tests exist to find.
#
# **A suffix rather than a lock**, deliberately: `smoke-enrol.sh` takes minutes, and serialising
# would make a push wait for whatever somebody is running by hand. Two runs are independent
# instead.
#
# The image tag stays shared. Two runs building the same content under one tag is fine, and the
# rebuild is most of the runtime.

# What makes one run's names different from another's.
#
# The PID is enough and is the honest default: two concurrent runs on one machine cannot share
# one. `GITHUB_RUN_ID` alone would not do — a re-run of the same CI run repeats it — so the
# attempt goes in with it, and `MS_SMOKE_RUN` overrides both for anyone who wants to name a run.
ms_smoke_run_id() {
  if [ -n "${MS_SMOKE_RUN:-}" ]; then
    printf '%s' "${MS_SMOKE_RUN}"
  elif [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf '%s-%s' "${GITHUB_RUN_ID}" "${GITHUB_RUN_ATTEMPT:-1}"
  else
    printf '%s' "$$"
  fi
}

# `ms_smoke_name core` -> `ms-smoke-core-12345`.
ms_smoke_name() {
  printf 'ms-smoke-%s-%s' "$1" "$(ms_smoke_run_id)"
}

# **What per-run names cost, and the price of not paying it.**
#
# Fixed names had one virtue: the next run tidied up after a killed one. Per-run names lose that,
# so a run that dies leaves its boxes behind for ever — and these are privileged systemd
# containers, not something to leak on somebody's laptop. This reaps them by age instead.
#
# **The age is a label, not a parsed date.** `docker inspect` hands back an ISO timestamp, and the
# two places this runs — a Mac and the Linux runner image — disagree about parsing one. So every
# container these scripts start carries the epoch second it was started at, and reaping is an
# integer comparison that behaves the same everywhere.
#
# An hour, because the longest harness here is minutes: anything older is not a run in progress.

# Pass to `docker run`: `docker run $(ms_smoke_labels) …`. Unquoted on purpose — these are two
# separate arguments, and the values are digits and a fixed word.
ms_smoke_labels() {
  printf -- '--label ms-smoke --label ms-smoke-started=%s' "$(date +%s)"
}

ms_smoke_reap_orphans() {
  local cutoff started id name
  cutoff=$(( $(date +%s) - 3600 ))
  for id in $(docker ps -aq --filter 'label=ms-smoke' 2>/dev/null); do
    started="$(docker inspect -f '{{ index .Config.Labels "ms-smoke-started" }}' "${id}" 2>/dev/null || true)"
    case "${started}" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ "${started}" -lt "${cutoff}" ]; then
      name="$(docker inspect -f '{{.Name}}' "${id}" 2>/dev/null | sed 's#^/##')"
      echo "    reaping orphaned smoke container ${name}"
      docker rm -f "${id}" >/dev/null 2>&1 || true
    fi
  done
  # Networks these scripts made. `network rm` refuses one that still has a container attached, so
  # this removes only the ones whose run is genuinely gone.
  local net
  for net in $(docker network ls -q --filter 'label=ms-smoke' 2>/dev/null); do
    docker network rm "${net}" >/dev/null 2>&1 || true
  done
}
