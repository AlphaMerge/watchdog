#!/usr/bin/env bash
# Run every unit suite, keep the whole log, and report what the counters hide (TASKS.md P-25).
#
#     ./scripts/test-all.sh              # every workspace
#     ./scripts/test-all.sh @ms/sensors  # one
#
# **`npm test` piped through `grep` is how a real failure went unexplained for a week.** A run of
# `@ms/sensors` reported 755 passed and 1 failed where a clean run reports 781. The arithmetic
# gives the shape — 755 + 1 + 25 = 781, so twenty-five tests were *cancelled*, which is what
# `node:test` does to a suite whose `before` hook throws — but the failure line itself was gone,
# because the run had been filtered to its summary counters. One hook broke, took a whole suite
# with it, and the evidence was discarded by the thing watching for it.
#
# So this keeps the log, and it fails on `cancelled` as loudly as on `failed`. A cancelled test
# did not pass; it never ran, and a summary that reports only pass/fail counts reads twenty-five
# tests that never ran as a suite that was fine.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
logs="${repo_root}/dev/data/test-logs"
mkdir -p "${logs}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="${logs}/${stamp}.log"

if [ "$#" -gt 0 ]; then
  command="npm test --workspace $1"
  what="$1"
else
  command="npm test"
  what="every workspace"
fi

echo "==> ${what}, full log in ${log}"
"${repo_root}/scripts/dev.sh" "${command}" > "${log}" 2>&1
status=$?

# node:test prints one summary block per workspace. Every counter is read, not just the two
# people look at.
sum() { awk -v key="$1" '$0 ~ "^ℹ " key " " { total += $3 } END { print total + 0 }' "${log}"; }
tests="$(sum tests)"
passed="$(sum pass)"
failed="$(sum fail)"
cancelled="$(sum cancelled)"
skipped="$(sum skipped)"

printf '    tests %s · pass %s · fail %s · cancelled %s · skipped %s\n' \
  "${tests}" "${passed}" "${failed}" "${cancelled}" "${skipped}"

if [ "${failed}" -gt 0 ]; then
  echo
  echo "==> failures"
  # The lines node:test writes under "failing tests", which is what a grep for counters loses.
  awk '/^✖ failing tests:/, 0' "${log}" | head -60
fi

if [ "${cancelled}" -gt 0 ]; then
  echo
  echo "==> ${cancelled} test(s) cancelled — a suite's before/after hook threw, and everything"
  echo "    in it never ran. This is not a pass. The suite and the hook's error:"
  # A cancelled test prints as `  ✖ name` with no duration — node:test gives a duration to
  # anything that actually ran — and the suite that owns it prints `✖ suite (0.6ms)` with the
  # error underneath. Both are wanted: the suite names what to look at, the error says why.
  grep -nE '^ *✖ [^(]+$' "${log}" | head -10
  echo "    ---"
  awk '/^✖ .*\(.*ms\)$/ { suite = $0 } /^ *Error:/ { print suite; print; exit }' "${log}"
  echo "    (full detail in the log)"
fi

if [ "${status}" -ne 0 ] || [ "${failed}" -gt 0 ] || [ "${cancelled}" -gt 0 ]; then
  echo
  echo "==> not clean. Full log: ${log}"
  exit 1
fi

echo "==> clean. Full log: ${log}"
