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

# **A skipped suite counts as one, however many tests are inside it** (`P-49`). `node:test` reports
# `describe(..., { skip: reason })` as a single skipped item, so a run with PostgreSQL down reported
# `skipped 15` while 1,296 of the core's 2,005 tests never ran — and printed `clean`, identically to
# a run that covered all of them. That is the same defect this script was written for: a counter
# that reads work-that-never-happened as work that was fine.
#
# Unlike `cancelled` this must not fail the run. Skipping when a dependency is absent is deliberate,
# and `npm test` is meant to work with the stack down. It just has to be impossible to miss.
skipped_suites="$(grep -cE '^ *﹣ .+ # ' "${log}" 2>/dev/null || true)"
skipped_suites="${skipped_suites:-0}"
if [ "${skipped_suites}" -gt 0 ]; then
  echo
  echo "==> ${skipped_suites} suite(s) skipped for a missing dependency — those tests did not run,"
  echo "    and are not in the counts above:"
  grep -oE '# [^#]+$' "${log}" 2>/dev/null | sed 's/^# //' | sort | uniq -c | sort -rn |
    awk '{ n = $1; $1 = ""; sub(/^ /, ""); printf "      %4d x %s\n", n, $0 }' | head -8
  echo "    Bring the stack up (npm run dev) to cover them."
fi

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

if [ "${skipped_suites}" -gt 0 ]; then
  echo "==> clean, but ${skipped_suites} suite(s) never ran. Full log: ${log}"
else
  echo "==> clean. Full log: ${log}"
fi
