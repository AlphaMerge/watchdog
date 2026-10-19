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
# is mounted read-only into each box, and the replay runs its build.
#
# Each box is privileged with no network (`--network none`): privileged to put the rows' servers
# on `lo` and to set the hostname, with nothing to reach but itself. Ubuntu 24.04 boots systemd
# with systemd-resolved running, its upstream the simulator, and the row whose server is the
# stub is played through it. Images build for this machine's architecture: on Apple silicon,
# arm64, as Rosetta cannot boot Ubuntu 24.04's systemd.
#
#   MS_DIFF_IMAGES="debian12 ubuntu2404"   only these (default: all of them)
#   MS_DIFF_ONLY=<id,id>                   only these rows (a partial run never verifies)
#   MS_DIFF_OUT=<dir>                      keep each image's run there (default: a temp dir)
#   MS_DIFF_WRITE=1                        write the recordings on a pass
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/smoke-names.sh
. "${repo_root}/scripts/lib/smoke-names.sh"

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

for file in names-replay.js names-lookup.js names-verify.js names-differential.js; do
  if [ ! -f "${repo_root}/${dist}/${file}" ] || [ "${repo_root}/${dist}/${file}" -ot \
    "${repo_root}/packages/probe/test/differential/${file%.js}.ts" ]; then
    echo "==> ${dist}/${file} is missing or older than its source: build first" >&2
    exit 2
  fi
done

out="${MS_DIFF_OUT:-$(mktemp -d)}"
mkdir -p "${out}"
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
while read -r name base resolved snapshot; do
  [ -n "${name}" ] || continue
  case " ${wanted} " in *" ${name} "*) ;; *) continue ;; esac
  image="ms-names-diff:${name}"
  echo "==> ${name}: building ${image} from ${base}"
  docker pull -q "${base}" >/dev/null
  docker build -q -t "${image}" --build-arg "BASE=${base}" --build-arg "RESOLVED=${resolved}" \
    --build-arg "APT_SNAPSHOT=${snapshot}" -f "${repo_root}/scripts/smoke/Dockerfile.names" \
    "${repo_root}/scripts/smoke" >/dev/null
  digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "${base}")"
  container="$(ms_smoke_name "names-${name}")"
  containers+=("${container}")
  docker rm -f "${container}" >/dev/null 2>&1 || true
  started="$(date +%s)"
  replay=(node "/ms/${dist}/names-replay.js" --rows "/ms/${rows}" --image "${name}" "${only[@]+"${only[@]}"}")
  if [ "${resolved}" = 1 ]; then
    # The labels are two separate arguments by design, so this expansion must split.
    # shellcheck disable=SC2046
    docker run -d --name "${container}" $(ms_smoke_labels) \
      --privileged --cgroupns=host --network none \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
      -v "${repo_root}:/ms:ro" -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}" \
      "${image}" /sbin/init >/dev/null
    for _ in $(seq 1 60); do
      state="$(docker exec "${container}" systemctl is-system-running 2>/dev/null || true)"
      [ "${state}" = "running" ] || [ "${state}" = "degraded" ] && break
      sleep 1
    done
    # resolved's upstream is the simulator, at 127.0.0.2; every cache cold; nothing but unicast
    # DNS; and a single-label name sent upstream, so the stub answers it as the plan says.
    # resolved asks its global servers only while some link has a routable address, and with no
    # network none has (it answers SERVFAIL at once, "network down"): a dummy link with an
    # address from the benchmarking range, 198.18.0.0/15, and the default route, which reach
    # nothing.
    docker exec "${container}" sh -c 'ip link add ms0 type dummy && ip addr add 198.18.0.1/24 dev ms0 && ip link set ms0 up && ip route add default dev ms0 && mkdir -p /etc/systemd/resolved.conf.d && cat > /etc/systemd/resolved.conf.d/ms-differential.conf <<EOF
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
    if [ "$(docker exec "${container}" systemctl is-active systemd-resolved)" != active ]; then
      echo "    FAILED: systemd-resolved is not running in ${name}" >&2
      failed=1
      continue
    fi
    echo "    systemd: ${state}; systemd-resolved: active, $(docker exec "${container}" resolvectl --version | head -1)"
    # The env reaches `docker exec` only as given here, not from `docker run`.
    if ! docker exec -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}" "${container}" \
      "${replay[@]}" --via-resolved >"${out}/${name}.json" 2>"${out}/${name}.log"; then
      echo "    FAILED: the replay stopped in ${name}:" >&2
      tail -5 "${out}/${name}.log" | sed 's/^/      /' >&2
      failed=1
      continue
    fi
    if [ "$(docker exec "${container}" systemctl is-active systemd-resolved)" != active ]; then
      echo "    FAILED: systemd-resolved stopped during the run in ${name}" >&2
      failed=1
    fi
  else
    # shellcheck disable=SC2046
    if ! docker run --rm --name "${container}" $(ms_smoke_labels) --privileged --network none \
      -v "${repo_root}:/ms:ro" -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}" \
      "${image}" "${replay[@]}" >"${out}/${name}.json" 2>"${out}/${name}.log"; then
      echo "    FAILED: the replay stopped in ${name}:" >&2
      tail -5 "${out}/${name}.log" | sed 's/^/      /' >&2
      failed=1
      continue
    fi
  fi
  docker rm -f "${container}" >/dev/null 2>&1 || true
  echo "    $(wc -l <"${out}/${name}.log" | tr -d ' ') rows in $(($(date +%s) - started)) s"
done <<<"${IMAGES}"

echo "==> verifying every image's run against the rows"
runs=()
for file in "${out}"/*.json; do
  [ "$(basename "${file}")" = recordings.json ] || runs+=("/out/$(basename "${file}")")
done
if [ "${#runs[@]}" -eq 0 ]; then
  echo "==> NAME GATE DIFFERENTIAL FAILED: no image ran" >&2
  exit 1
fi
if docker run --rm --network none -v "${repo_root}:/ms:ro" -v "${out}:/out:ro" \
  ms-names-diff:debian12 node "/ms/${dist}/names-verify.js" "/ms/${rows}" "${runs[@]}" \
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
