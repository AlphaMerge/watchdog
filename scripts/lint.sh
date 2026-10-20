#!/usr/bin/env bash
# Lint the whole tree: one eslint process for each workspace, and one for the rest (`H-53`).
#
#     npm run lint              # every workspace, then everything outside packages/
#     npm run lint:fix          # the same, with --fix
#
# **`eslint .` stopped fitting in its heap.** The config lints with type information
# (`strictTypeChecked`, `projectService`), so one process holds the TypeScript program of every
# package at once. At rc.3's cut (step 0.4, 2026-10-20) it ran out of Node's default heap two
# minutes in and aborted, after the suite had passed. So each workspace gets a process of its own,
# which holds only that package's programs, and the heap is raised for the largest
# (`MS_LINT_HEAP_MB`, 4,096 by default). The VM holds that beside one other heavy run.
#
# Every target is linted even when an earlier one fails, so one run reports every error.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}" || exit 1
eslint="${MS_ESLINT:-${repo_root}/node_modules/.bin/eslint}"
heap="${MS_LINT_HEAP_MB:-4096}"
case "${heap}" in
  '' | 0* | *[!0-9]*)
    echo "lint: MS_LINT_HEAP_MB must be a whole number of megabytes, not '${heap}'" >&2
    exit 2
    ;;
esac
export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=${heap}"

status=0
for dir in packages/*/; do
  dir="${dir%/}"
  echo "==> eslint ${dir}"
  "${eslint}" "$@" "${dir}" || status=1
done
echo "==> eslint (outside packages/)"
"${eslint}" "$@" --ignore-pattern 'packages/**' . || status=1
exit "${status}"
