#!/usr/bin/env bash
# What a checkout is, for a package to stamp (`H-11`, `H-20`).
#
# Source this; it defines functions and sets nothing else.
#
# **Fails closed.** Every packaging script used to ask `git status --porcelain 2>/dev/null` and
# read empty output as clean, so a `git` that errored — a locked index, a repository it could not
# read — stamped `dirty: false` on whatever was there. Here any error from `git` is an error, with
# git's own words left on stderr, and the caller refuses to stamp.
#
# **A fingerprint, not a yes or no.** Being dirty before a build and after it says nothing about
# whether the tree changed in between: an edit to a file already modified, or to one already
# untracked, leaves `git status` exactly as it was. The fingerprint covers what `git status` lists
# and the content of every modified or untracked file, so a build that took minutes can be asked
# afterwards whether it compiled the tree that was stamped.
#
# **Writes nothing into the repository.** No temporary index and no objects: the toolchain
# container runs as root, and a root-owned file under `.git` breaks the checkout it came from.
# `--no-optional-locks` keeps `git status` from refreshing the index as it reads it.

# `ms_tree_state <repo>` prints `<commit> <dirty> <fingerprint>` on one line: the full commit,
# 1 if anything is modified or untracked (ignored files are not), and a hash that changes when any
# of that does. Returns non-zero, having printed nothing on stdout, when `git` cannot answer.
#
# **No `set -e` anywhere in here.** Bash switches `-e` off for everything run as the condition of
# an `if`, or on the left of `||`, and that includes a function and every subshell inside it, even
# one that sets `-e` again. The callers are exactly that (`if ! state="$(ms_tree_state …)"`), and a
# first version that relied on it printed a clean state after `git status` had failed. So every
# step exits on its own failure, and `pipefail`, which is not switched off, carries a failure out
# of each pipeline. Nothing here needs more than the bash 3.2 macOS ships, because the smoke
# harnesses run on the developer's host.
ms_tree_state() {
  (
    set -o pipefail
    root="$1"
    head="$(git -C "${root}" rev-parse --verify HEAD)" || exit 1
    status="$(git -C "${root}" --no-optional-locks status --porcelain=v1 --untracked-files=all)" \
      || exit 1
    dirty=0
    [ -z "${status}" ] || dirty=1
    # Every `git` here takes `-C`, the hashing ones too: git looks for a repository wherever it
    # is run, and from inside the toolchain container a worktree names a `.git` that is not
    # there, which git treats as fatal even for a command that needs no repository.
    fingerprint="$(
      {
        printf '%s\n' "${head}" &&
          git -C "${root}" --no-optional-locks status --porcelain=v1 -z --untracked-files=all &&
          # Paths relative to the root, one per line, which is what `--stdin-paths` reads. A
          # deleted file is already in the status above, and has no content to hash.
          git -C "${root}" ls-files -z --modified --others --exclude-standard \
          | (cd "${root}" && while IFS= read -r -d '' path; do
              if [ -f "${path}" ]; then printf '%s\n' "${path}"; fi
            done) \
          | git -C "${root}" hash-object --no-filters --stdin-paths
      } | git -C "${root}" hash-object --stdin
    )" || exit 1
    printf '%s %s %s\n' "${head}" "${dirty}" "${fingerprint}"
  )
}
