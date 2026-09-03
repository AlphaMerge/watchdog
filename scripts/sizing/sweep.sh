#!/usr/bin/env bash
# Sizing sweep for H-08: sensor counts against machine sizes, measured.
#
#     ./scripts/sizing/sweep.sh            # every tier
#     ./scripts/sizing/sweep.sh 2          # just the 2-core tier
#
# **The tiers are real constraints, not simulated ones.** Each run is the same benchmark in a
# container given `--cpus` and `--memory`, because what a probe can do with two cores is a
# property of the box; modelling it in-process would measure the model. The pool settings are the
# ones the release ships — a ceiling of 48 and a floor of 4 — so a number here is what an operator
# gets rather than what a tuned probe could reach.
#
# Results are one JSON object per line on stdout, for `report.mjs`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image=node:24-bookworm-slim

tiers=("${@:-2 4 8}")
# shellcheck disable=SC2206
tiers=(${tiers[*]})

# Below the v1 target and through it. 100 is a small office, 5,000 is `CAPABILITIES.MD` §13.
counts=(100 500 1000 2500 5000)
seconds="${MS_SIZING_SECONDS:-60}"

for cpus in "${tiers[@]}"; do
  # 1 GB a core is the shape of every small cloud instance, and enough that memory is never the
  # thing that fails first — this measures what the scheduler can hold, not what an OOM kill does.
  memory="$((cpus * 1024))m"
  for sensors in "${counts[@]}"; do
    echo "==> ${cpus} cores, ${memory}, ${sensors} sensors" >&2
    docker run --rm \
      --cpus="${cpus}" --memory="${memory}" \
      -v "${repo_root}:/workspace" -w /workspace \
      -e MS_SIZING_SENSORS="${sensors}" \
      -e MS_SIZING_SECONDS="${seconds}" \
      -e MS_SIZING_POOL_MAX=48 \
      "${image}" node scripts/sizing/bench.mjs
  done
done
