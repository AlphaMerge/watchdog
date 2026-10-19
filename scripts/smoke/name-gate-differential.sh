#!/usr/bin/env bash
# The name gate's differential (TASKS.md P-432 S8, the design's D30 and §7.5).
#
# Development only: run by hand on the VM, before the rc.3 cut. It replays every row S4 exported
# (packages/probe/test/fixtures/system-names-rows.json) in a box of each image the rows name,
# against that image's real getaddrinfo, with the S5 DNS simulator as every server, and fails on
# any row where the gate's name policy disagrees with what glibc did: the class (`local` against a
# walk), the candidates and types asked and the servers, in order, try by try. On a pass it
# prints the recordings file; `MS_DIFF_WRITE=1` writes it to
# packages/probe/test/fixtures/system-names-recordings.json, which system-names.test then holds
# every row to.
#
# Build first, from the worktree root: ./scripts/dev.sh "npx tsc -b packages/probe". The worktree
# is mounted read-only into each box, and the replay runs its build, so the run refuses to start
# while any source the boxes load is newer than its build (`ms_names_diff_stale`). Each image's
# run carries the sha256 of the rows file and of the policy's build, and the verdict holds them to
# the files as they are: a run is judged only against what it ran.
#
# Each base is the digest the committed recordings were made on, so the same tree gives the same
# verdict on another day; `MS_DIFF_REFRESH=1` moves to the tags' current images and prints each
# old and new digest. An image with no recording takes its tag's current image, and says so.
#
# Each box is privileged with no network (`--network none`): privileged to put the rows' servers
# on `lo` and to set the hostname, with nothing to reach but itself. Ubuntu 24.04 boots systemd
# with systemd-resolved running, its upstream the simulator, and the row whose server is the
# stub is played through it. Images build for this machine's architecture: on Apple silicon,
# arm64, as Rosetta cannot boot Ubuntu 24.04's systemd.
#
#   MS_DIFF_IMAGES="debian12 ubuntu2404"   only these (default: all of them)
#   MS_DIFF_ONLY=<id,id>                   only these rows (a partial run never verifies)
#   MS_DIFF_OUT=<dir>                      keep each image's run there (default: a temp dir); an
#                                          earlier run's files there are removed first, and the
#                                          verdict takes only the runs this invocation made
#   MS_DIFF_REFRESH=1                      the tags' current images, not the recorded digests
#   MS_DIFF_WRITE=1                        write the recordings on a pass
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/smoke-names.sh
. "${repo_root}/scripts/lib/smoke-names.sh"
# shellcheck source=../lib/names-diff.sh
. "${repo_root}/scripts/lib/names-diff.sh"

rows="packages/probe/test/fixtures/system-names-rows.json"
recordings="packages/probe/test/fixtures/system-names-recordings.json"
dist="packages/probe/dist/test/differential"

# name base resolved apt-snapshot: each image the rows name.
IMAGES="
rocky8 rockylinux:8 0 0
debian11 debian:bullseye 0 1
rocky9 rockylinux:9 0 0
ubuntu2204 ubuntu:22.04 0 0
debian12 debian:bookworm 0 0
ubuntu2404 ubuntu:24.04 1 0
debian13 debian:trixie 0 0
"

if ! stale="$(ms_names_diff_stale "${repo_root}")"; then
  echo "==> the boxes load the build, and these sources are newer than it or not built: build first" >&2
  echo "${stale}" | head -20 | sed 's/^/      /' >&2
  exit 2
fi

out="${MS_DIFF_OUT:-$(mktemp -d)}"
mkdir -p "${out}"
# The verdict is this invocation's runs and nothing else: an earlier run's files go first.
while read -r name _; do
  [ -n "${name}" ] || continue
  rm -f "${out}/${name}.json" "${out}/${name}.json.partial" "${out}/${name}.log"
done <<<"${IMAGES}"
rm -f "${out}/recordings.json" "${out}/verify.log"
wanted="${MS_DIFF_IMAGES:-$(echo "${IMAGES}" | awk 'NF { print $1 }' | tr '\n' ' ')}"
only=()
if [ -n "${MS_DIFF_ONLY:-}" ]; then only=(--only "${MS_DIFF_ONLY}"); fi
containers=()

cleanup() {
  for container in "${containers[@]+"${containers[@]}"}"; do
    docker rm -f "${container}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
ms_smoke_reap_orphans

failed=0
runs=()
verify_image=""
while read -r name base resolved snapshot; do
  [ -n "${name}" ] || continue
  case " ${wanted} " in *" ${name} "*) ;; *) continue ;; esac
  image="ms-names-diff:${name}"
  recorded="$(ms_names_diff_recorded "${repo_root}/${recordings}" "${name}" "${base}")"
  if [ "${MS_DIFF_REFRESH:-0}" = 1 ] || [ -z "${recorded}" ]; then
    docker pull -q "${base}" >/dev/null
    digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${base}" |
      grep "^${base%%:*}@sha256:" | head -1 || true)"
    if [ -z "${digest}" ]; then
      echo "    FAILED: ${base} has no digest from ${base%%:*}" >&2
      failed=1
      continue
    fi
    if [ -z "${recorded}" ]; then
      echo "    ${base}: no digest recorded for ${name}; the tag is ${digest}"
    elif [ "${recorded}" != "${digest}" ]; then
      echo "    ${base}: MOVED, recorded on ${recorded}, the tag is now ${digest}"
    else
      echo "    ${base}: the tag is still ${digest}"
    fi
  else
    digest="${recorded}"
    if ! docker pull -q "${digest}" >/dev/null; then
      echo "    FAILED: could not pull ${digest}, the recorded ${base}; MS_DIFF_REFRESH=1 takes the tag's current image" >&2
      failed=1
      continue
    fi
  fi
  echo "==> ${name}: building ${image} from ${digest}"
  docker build -q -t "${image}" --build-arg "BASE=${digest}" --build-arg "RESOLVED=${resolved}" \
    --build-arg "APT_SNAPSHOT=${snapshot}" -f "${repo_root}/scripts/smoke/Dockerfile.names" \
    "${repo_root}/scripts/smoke" >/dev/null
  verify_image="${image}"
  container="$(ms_smoke_name "names-${name}")"
  containers+=("${container}")
  docker rm -f "${container}" >/dev/null 2>&1 || true
  started="$(date +%s)"
  # Bounded inside the box, as the Mac has no timeout: an image's rows take about 140 s.
  replay=(timeout 1500 node "/ms/${dist}/names-replay.js" --rows "/ms/${rows}" --image "${name}"
    "${only[@]+"${only[@]}"}")
  if [ "${resolved}" = 1 ]; then
    # The labels are two separate arguments by design, so this expansion must split.
    # shellcheck disable=SC2046
    docker run -d --name "${container}" $(ms_smoke_labels) \
      --privileged --cgroupns=host --network none \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
      -v "${repo_root}:/ms:ro" -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}" \
      "${image}" /sbin/init >/dev/null
    for _ in $(seq 1 60); do
      state="$(docker exec "${container}" timeout 10 systemctl is-system-running 2>/dev/null || true)"
      [ "${state}" = "running" ] || [ "${state}" = "degraded" ] && break
      sleep 1
    done
    # resolved's upstream is the simulator, at 127.0.0.2; every cache cold; nothing but unicast
    # DNS; and a single-label name sent upstream, so the stub answers it as the plan says.
    # resolved asks its global servers only while some link has a routable address, and with no
    # network none has (it answers SERVFAIL at once, "network down"): a dummy link with an
    # address from the benchmarking range, 198.18.0.0/15, and the default route, which reach
    # nothing.
    docker exec "${container}" timeout 120 sh -c 'ip link add ms0 type dummy && ip addr add 198.18.0.1/24 dev ms0 && ip link set ms0 up && ip route add default dev ms0 && mkdir -p /etc/systemd/resolved.conf.d && cat > /etc/systemd/resolved.conf.d/ms-differential.conf <<EOF
[Resolve]
DNS=127.0.0.2
Domains=~.
Cache=no
DNSSEC=no
DNSOverTLS=no
LLMNR=no
MulticastDNS=no
ResolveUnicastSingleLabel=yes
EOF
systemctl restart systemd-resolved'
    if [ "$(docker exec "${container}" timeout 10 systemctl is-active systemd-resolved || true)" != active ]; then
      echo "    FAILED: systemd-resolved is not running in ${name}" >&2
      failed=1
      continue
    fi
    echo "    systemd: ${state}; systemd-resolved: active, $(docker exec "${container}" timeout 10 resolvectl --version | head -1)"
    # The env reaches `docker exec` only as given here, not from `docker run`. The run is written
    # aside and kept only whole: a replay that stops leaves no run for the verdict to choke on.
    if ! docker exec -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}" "${container}" \
      "${replay[@]}" --via-resolved >"${out}/${name}.json.partial" 2>"${out}/${name}.log"; then
      rm -f "${out}/${name}.json.partial"
      echo "    FAILED: the replay stopped in ${name}:" >&2
      tail -5 "${out}/${name}.log" | sed 's/^/      /' >&2
      failed=1
      continue
    fi
    mv "${out}/${name}.json.partial" "${out}/${name}.json"
    runs+=("/out/${name}.json")
    if [ "$(docker exec "${container}" timeout 10 systemctl is-active systemd-resolved || true)" != active ]; then
      echo "    FAILED: systemd-resolved stopped during the run in ${name}" >&2
      failed=1
    fi
  else
    # shellcheck disable=SC2046
    if ! docker run --rm --name "${container}" $(ms_smoke_labels) --privileged --network none \
      -v "${repo_root}:/ms:ro" -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}" \
      "${image}" "${replay[@]}" >"${out}/${name}.json.partial" 2>"${out}/${name}.log"; then
      rm -f "${out}/${name}.json.partial"
      echo "    FAILED: the replay stopped in ${name}:" >&2
      tail -5 "${out}/${name}.log" | sed 's/^/      /' >&2
      failed=1
      continue
    fi
    mv "${out}/${name}.json.partial" "${out}/${name}.json"
    runs+=("/out/${name}.json")
  fi
  docker rm -f "${container}" >/dev/null 2>&1 || true
  echo "    $(wc -l <"${out}/${name}.log" | tr -d ' ') rows in $(($(date +%s) - started)) s"
done <<<"${IMAGES}"

echo "==> verifying every image's run against the rows"
if [ "${#runs[@]}" -eq 0 ] || [ -z "${verify_image}" ]; then
  echo "==> NAME GATE DIFFERENTIAL FAILED: no image ran" >&2
  exit 1
fi
# In a box this invocation built: any of them has the Node the verdict needs.
if docker run --rm --network none -v "${repo_root}:/ms:ro" -v "${out}:/out:ro" \
  "${verify_image}" timeout 300 node "/ms/${dist}/names-verify.js" "/ms/${rows}" "${runs[@]}" \
  >"${out}/recordings.json" 2>"${out}/verify.log"; then
  cat "${out}/verify.log"
else
  cat "${out}/verify.log" >&2
  failed=1
fi
if [ "${failed}" != 0 ]; then
  echo "==> NAME GATE DIFFERENTIAL FAILED (runs in ${out})" >&2
  exit 1
fi
if [ "${MS_DIFF_WRITE:-0}" = 1 ]; then
  cp "${out}/recordings.json" "${repo_root}/${recordings}"
  echo "    wrote ${recordings}: run prettier on it"
fi
echo "==> NAME GATE DIFFERENTIAL PASSED (runs in ${out})"
