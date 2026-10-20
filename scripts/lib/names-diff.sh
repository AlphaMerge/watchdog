#!/usr/bin/env bash
# Helpers for the name gate's differential (`scripts/smoke/name-gate-differential.sh`, TASKS.md
# P-432 S8). Source this; it defines functions and sets nothing else. Each runs on the host, with
# no Node and no git, and `packages/probe/test/names-differential.test.ts` runs each against
# files it writes.

# The sources whose build the boxes load, each with its build: the policy and the rest of the
# probe, the replay and what it imports from the probe's tests, the simulator, the system lookup,
# and the shared package under them.
MS_NAMES_DIFF_BUILT="
packages/probe/src packages/probe/dist/src
packages/probe/test/differential packages/probe/dist/test/differential
packages/probe/test/support packages/probe/dist/test/support
packages/simulators/src packages/simulators/dist/src
packages/sensors/src packages/sensors/dist/src
packages/shared/src packages/shared/dist/src
"

# `ms_names_diff_stale <repo root>`: prints each source, from the root, whose build is missing or
# older than it, and fails if there is one. A box loads the build, never the source, so a source
# edited and not built would be judged as it was, and a mutant restored in the source and not
# rebuilt would be judged as the mutant. A source newer than its `.js` is still built when it is
# older than its package's `dist/tsconfig.tsbuildinfo`: `tsc -b` re-emits nothing for a file
# touched with its text unchanged, and records in the build info that it has seen it.
ms_names_diff_stale() {
  local root="$1" src dist file js info stale=0
  while read -r src dist; do
    [ -n "${src}" ] || continue
    [ -d "${root}/${src}" ] || continue
    info="${root}/${dist%%/dist/*}/dist/tsconfig.tsbuildinfo"
    while IFS= read -r -d '' file; do
      js="${root}/${dist}/${file#"${root}/${src}/"}"
      js="${js%.ts}.js"
      if [ ! -f "${js}" ] || { [ "${js}" -ot "${file}" ] && [ "${info}" -ot "${file}" ]; }; then
        printf '%s\n' "${file#"${root}/"}"
        stale=1
      fi
    done < <(find "${root}/${src}" -name '*.ts' ! -name '*.d.ts' -print0)
  done <<<"${MS_NAMES_DIFF_BUILT}"
  return "${stale}"
}

# `ms_names_diff_counts <image> <replay log>`: how many of S4's rows and of the answer rows the
# replay played in the image, by its line for each (`<image> <row id> <title>: …`), where an S4
# row's id is 16 hex digits and an answer row's begins `answer-`. Anything else the replay said on
# stderr is no row.
ms_names_diff_counts() {
  local image="$1" log="$2"
  awk -v image="${image}" '
    $1 == image && length($2) == 16 && $2 ~ /^[0-9a-f]+$/ { rows += 1 }
    $1 == image && $2 ~ /^answer-/ { answers += 1 }
    END { printf "%d rows and %d answer rows\n", rows, answers }
  ' "${log}"
}

# `ms_names_diff_recorded <recordings.json> <image> <base>`: prints the digest the recordings hold
# for the image's base (`ubuntu@sha256:…`), or nothing when they hold none for it or recorded it
# from another base. The file is the verdict's own JSON, two spaces an indent, as prettier keeps
# it: `images`, then each image, then its `base` and `digest`.
ms_names_diff_recorded() {
  local recordings="$1" image="$2" base="$3"
  [ -f "${recordings}" ] || return 0
  awk -v want="${image}" -v base="${base}" '
    /^  "images": \{/ { images = 1; next }
    images && /^  \}/ { exit }
    images && $0 == "    \"" want "\": {" { inside = 1; next }
    inside && /^    \}/ { exit }
    inside && /^      "base": / { seen = $0; sub(/^      "base": "/, "", seen); sub(/",?$/, "", seen) }
    inside && /^      "digest": / { digest = $0; sub(/^      "digest": "/, "", digest); sub(/",?$/, "", digest) }
    END {
      hex = substr(digest, index(digest, "@sha256:") + 8)
      if (seen == base && digest ~ /^[^@ ]+@sha256:[0-9a-f]+$/ && length(hex) == 64) print digest
    }
  ' "${recordings}"
}
