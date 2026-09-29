#!/usr/bin/env bash
# Builds ms-server's own copy of a commit (`H-24`). Run inside the toolchain container by
# `scripts/dev-services.sh build`, with the tree as a tar on stdin and the commit as $1.
#
# **ms-server runs this build and never the checkout's.** It migrates the shared development
# database on every start, and it used to do that from the checkout's `dist` — so a session that
# built a migration before it landed had it applied to everybody's database, and when the file was
# edited before landing, every start after refused (`P-238`'s case: 059, about 470 restarts).
# Built here, from origin/main, only a landed migration reaches that database.
#
# The build lives in a Docker volume at /ms-server rather than a worktree on the host, so nothing
# that sweeps the repository — eslint, prettier, shellcheck, a Docker build context — ever finds a
# second copy of it, and no session's `git worktree list` has one more entry to wonder about.
set -euo pipefail

commit="${1:?usage: ms-server-build.sh <commit> < tree.tar}"
root=/ms-server
cd "${root}"

if [ "$(cat .built-commit 2>/dev/null || true)" = "${commit}" ]; then
  cat >/dev/null # the archive, unread
  echo "ms-server: build is already ${commit}"
  exit 0
fi

# Unmarked until it has finished, so a build that fails half-way is built again, not run.
rm -f .built-commit
# Everything but the installed modules, so a file deleted upstream is deleted here too. **At any
# depth**: a workspace keeps modules of its own beside its sources where it needs a version the
# root does not hoist — `shared`'s ajv 8 under the root's ajv 6 — and a build that lost them
# resolved the root's and failed to compile.
find . -name node_modules -prune -o \( -type f -o -type l \) -exec rm -f {} +
find . -mindepth 1 -type d -empty -not -path '*/node_modules/*' -delete
tar -x

# The modules only when the lock file has changed, because they are most of the time a build takes.
if ! cmp -s package-lock.json node_modules/.ms-server-build-lock; then
  npm ci --no-audit
  cp package-lock.json node_modules/.ms-server-build-lock
fi

npx tsc -b packages/core packages/probe

# Which commit this is, where the services read it (`H-11`), so the start line names it rather
# than calling itself a working tree.
for pkg in core probe; do
  printf '{"version":"0.0.0-dev","commit":"%s","dirty":false,"profile":"full"}\n' "${commit}" \
    >"packages/${pkg}/build.json"
done

echo "${commit}" >.built-commit
echo "ms-server: built ${commit}"
