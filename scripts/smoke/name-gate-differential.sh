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
# Each plan is played twice, in separate runs (`P-460`, D30): glibc's wire (A), and the name
# check's walk alone (B, `DnsCheck.route` with no lanes and no helper), which the verdict holds to
# glibc's; then the same lookup through the probe's resolver in `system` and `gate` mode, in the
# helper's child and on the probe's lanes (§7.5's regressions). Beside the rows: the answer rows
# (TC with TCP/53 refused, FORMERR, A with AAAA SERVFAIL, EDNS-intolerant servers) in every image;
# the budget boxes in front of a 150-name silent zone: dnsmasq at `dns-forward-max=30` (a box of
# Debian 12 with `dnsmasq-base`) in both modes and in gate mode after a helper SIGKILL, and
# systemd-resolved (in Ubuntu 24.04's box, after its rows) in both modes, with no SIGKILL arm; and
# the boxes with the check off in situ (`P-461`): nscd running, libnss-resolve's and
# libnss-mdns's hosts: lines, LD_PRELOAD and /etc/ld.so.preload. §7.5's other rows (`P-462`): the
# sequence rows in every image after the answer rows (a partial key, several lookups through one
# check; `_gateway` on a host with an IPv4 default gateway and no IPv6 one); more boxes with the
# check off (`sss` and `mdns4_minimal` before `files`, `files resolve dns`, `LOCALDOMAIN=""`, and
# systemd-resolved's stub refused under `resolve`, in a box booted with systemd); and the skew
# boxes, a file edited under a running probe in gate mode and its helper then SIGKILLed (gai.conf
# at Debian 12, nsswitch.conf at Debian 11, where glibc reads it once, and at Debian 12, where it
# does not). Every one must hold for the run to pass. Every image's run and every box's carries
# the build it loaded, and says if it changed while it ran: the verdict takes only runs of the
# build as it is then.
#
#   MS_DIFF_IMAGES="debian12 ubuntu2404"   only these (default: all of them)
#   MS_DIFF_ONLY=<id,id>                   only these rows (a partial run never verifies)
#   MS_DIFF_BOXES="budget off skew"        the boxes beside the rows (default all three; `none`:
#                                          none, and the run never verifies)
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

# case image package boot: each box with the check off (`P-461`, `P-462`), built on the image's
# base with the package installed as an operator would (`-` for none); `boot` 1 boots it with
# systemd and systemd-resolved, as Ubuntu 24.04's replay box is.
OFF_BOXES="
nscd debian12 nscd 0
mdns4_minimal debian12 libnss-mdns 0
resolve ubuntu2404 libnss-resolve 0
ld-preload debian12 - 0
ld-so-preload debian12 - 0
sss-first debian12 libnss-sss 0
mdns4-first debian12 libnss-mdns 0
files-resolve-dns ubuntu2404 libnss-resolve 0
stub-refused ubuntu2404 libnss-resolve 1
localdomain-empty debian12 - 0
"
# case image: each skew box (`P-462`, D28), on the image's base with nothing added.
SKEW_BOXES="
gai debian12
nsswitch-frozen debian11
nsswitch-reloaded debian12
"
boxes=" ${MS_DIFF_BOXES:-budget off skew} "
want_box() { case "${boxes}" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# `image_row <name>`: the image's base, resolved and apt-snapshot columns.
image_row() {
  echo "${IMAGES}" | awk -v want="$1" '$1 == want { print $2, $3, $4 }'
}

# `base_digest <name> <base>`: the digest a box of the image is built on, the recorded one unless
# MS_DIFF_REFRESH=1 or none is recorded, then the tag's current one. Prints it; says why on stderr.
base_digest() {
  local name="$1" base="$2" recorded digest
  recorded="$(ms_names_diff_recorded "${repo_root}/${recordings}" "${name}" "${base}")"
  if [ "${MS_DIFF_REFRESH:-0}" = 1 ] || [ -z "${recorded}" ]; then
    docker pull -q "${base}" >/dev/null
    digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${base}" |
      grep "^${base%%:*}@sha256:" | head -1 || true)"
    if [ -z "${digest}" ]; then
      echo "    FAILED: ${base} has no digest from ${base%%:*}" >&2
      return 1
    fi
    if [ -z "${recorded}" ]; then
      echo "    ${base}: no digest recorded for ${name}; the tag is ${digest}" >&2
    elif [ "${recorded}" != "${digest}" ]; then
      echo "    ${base}: MOVED, recorded on ${recorded}, the tag is now ${digest}" >&2
    else
      echo "    ${base}: the tag is still ${digest}" >&2
    fi
  else
    digest="${recorded}"
    if ! docker pull -q "${digest}" >/dev/null; then
      echo "    FAILED: could not pull ${digest}, the recorded ${base}; MS_DIFF_REFRESH=1 takes the tag's current image" >&2
      return 1
    fi
  fi
  printf '%s\n' "${digest}"
}

# `build_box <tag> <digest> <resolved> <snapshot> <packages>`
build_box() {
  docker build -q -t "$1" --build-arg "BASE=$2" --build-arg "RESOLVED=$3" \
    --build-arg "APT_SNAPSHOT=$4" --build-arg "EXTRA=$5" \
    -f "${repo_root}/scripts/smoke/Dockerfile.names" "${repo_root}/scripts/smoke" >/dev/null
}

# `boot_box <container> <tag> <docker run options…>`: the box started with systemd as its init,
# privileged with no network, and waited on for systemd to be running; prints the state reached.
boot_box() {
  local container="$1" tag="$2" state=""
  shift 2
  # The labels are two separate arguments by design, so this expansion must split.
  # shellcheck disable=SC2046
  docker run -d --name "${container}" $(ms_smoke_labels) \
    --privileged --cgroupns=host --network none \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
    -v "${repo_root}:/ms:ro" "$@" "${tag}" /sbin/init >/dev/null
  for _ in $(seq 1 60); do
    state="$(docker exec "${container}" timeout 10 systemctl is-system-running 2>/dev/null || true)"
    [ "${state}" = "running" ] || [ "${state}" = "degraded" ] && break
    sleep 1
  done
  printf '%s\n' "${state}"
}

# `keep_run <file>`: a box's stdout went to `<file>.partial`; it is kept whole, for the verdict.
keep_run() {
  mv "${out}/$1.partial" "${out}/$1"
  runs+=("/out/$1")
}

# `say_played <image> <started>`: the rows the image's replay played, by its own line for each,
# and how long the replay took from the box's start, before any budget box after it.
say_played() {
  echo "    $(ms_names_diff_counts "$1" "${out}/$1.log") in $(($(date +%s) - $2)) s"
}

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
rm -f "${out}/recordings.json" "${out}/verify.log" "${out:?}"/off-*.json* "${out:?}"/off-*.log \
  "${out:?}"/budget-*.json* "${out:?}"/budget-*.log "${out:?}"/skew-*.json* "${out:?}"/skew-*.log
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
  if ! digest="$(base_digest "${name}" "${base}")"; then
    failed=1
    continue
  fi
  echo "==> ${name}: building ${image} from ${digest}"
  build_box "${image}" "${digest}" "${resolved}" "${snapshot}" ""
  verify_image="${image}"
  container="$(ms_smoke_name "names-${name}")"
  containers+=("${container}")
  docker rm -f "${container}" >/dev/null 2>&1 || true
  started="$(date +%s)"
  # Bounded inside the box, as the Mac has no timeout: an image's rows, each plan played for
  # glibc, for the walk and for the regression, took 5 to 8 minutes in run 4.
  replay=(timeout 3600 node "/ms/${dist}/names-replay.js" --rows "/ms/${rows}" --image "${name}"
    "${only[@]+"${only[@]}"}")
  if [ "${resolved}" = 1 ]; then
    state="$(boot_box "${container}" "${image}" -e "MS_DIFF_BASE=${base}" -e "MS_DIFF_DIGEST=${digest}")"
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
    keep_run "${name}.json"
    say_played "${name}" "${started}"
    if [ "$(docker exec "${container}" timeout 10 systemctl is-active systemd-resolved || true)" != active ]; then
      echo "    FAILED: systemd-resolved stopped during the run in ${name}" >&2
      failed=1
    fi
    # §7.5's resolved budget row, in this box after its rows: resolved in front of a silent zone.
    if want_box budget; then
      echo "==> budget box resolved, in ${name}"
      budget_started="$(date +%s)"
      if docker exec "${container}" timeout 900 node "/ms/${dist}/names-budget.js" \
        --forwarder resolved --image "${name}" >"${out}/budget-resolved.json.partial" \
        2>"${out}/budget-resolved.log"; then
        keep_run budget-resolved.json
        sed 's/^/    /' "${out}/budget-resolved.log"
        echo "    the resolved budget box in $(($(date +%s) - budget_started)) s"
      else
        mv "${out}/budget-resolved.json.partial" "${out}/budget-resolved.json.failed"
        echo "    FAILED: the resolved budget box stopped:" >&2
        tail -5 "${out}/budget-resolved.log" | sed 's/^/      /' >&2
        failed=1
      fi
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
    keep_run "${name}.json"
    say_played "${name}" "${started}"
  fi
  docker rm -f "${container}" >/dev/null 2>&1 || true
done <<<"${IMAGES}"

# `run_box <name> <tag> <command…>`: a box of its own, privileged with no network, its stdout the
# run kept as `<name>.json`.
run_box() {
  local box="$1" tag="$2" container
  shift 2
  container="$(ms_smoke_name "names-${box}")"
  containers+=("${container}")
  docker rm -f "${container}" >/dev/null 2>&1 || true
  # shellcheck disable=SC2046
  if docker run --rm --name "${container}" $(ms_smoke_labels) --privileged --network none \
    -v "${repo_root}:/ms:ro" "${tag}" "$@" >"${out}/${box}.json.partial" 2>"${out}/${box}.log"; then
    keep_run "${box}.json"
    sed 's/^/    /' "${out}/${box}.log"
  else
    mv "${out}/${box}.json.partial" "${out}/${box}.json.failed"
    echo "    FAILED: the ${box} box stopped:" >&2
    tail -5 "${out}/${box}.log" | sed 's/^/      /' >&2
    failed=1
  fi
}

# §7.5's dnsmasq budget row: dnsmasq at dns-forward-max=30, in a Debian 12 box of its own.
if want_box budget; then
  read -r base _ snapshot <<<"$(image_row debian12)"
  if digest="$(base_digest debian12 "${base}")"; then
    echo "==> budget box dnsmasq: building ms-names-diff:debian12-dnsmasq from ${digest}"
    build_box ms-names-diff:debian12-dnsmasq "${digest}" 0 "${snapshot}" dnsmasq-base
    verify_image="ms-names-diff:debian12-dnsmasq"
    run_box budget-dnsmasq ms-names-diff:debian12-dnsmasq timeout 900 node \
      "/ms/${dist}/names-budget.js" --forwarder dnsmasq --image debian12
  else
    failed=1
  fi
fi

# The boxes with the check off in situ (`P-461`, `P-462`).
if want_box off; then
  while read -r box image package boot; do
    [ -n "${box}" ] || continue
    [ "${package}" != - ] || package=""
    read -r base _ snapshot <<<"$(image_row "${image}")"
    if ! digest="$(base_digest "${image}" "${base}")"; then
      failed=1
      continue
    fi
    tag="ms-names-diff:${image}-${box}"
    booted=""
    [ "${boot}" != 1 ] || booted=", booted with systemd"
    echo "==> off box ${box}: building ${tag} from ${digest}${package:+ with ${package}}${booted}"
    build_box "${tag}" "${digest}" "${boot}" "${snapshot}" "${package}"
    verify_image="${tag}"
    if [ "${boot}" != 1 ]; then
      run_box "off-${box}" "${tag}" timeout 120 node "/ms/${dist}/names-off.js" --case "${box}" \
        --image "${image}"
      continue
    fi
    # Booted with systemd and systemd-resolved, as the case's own setup needs them.
    container="$(ms_smoke_name "names-off-${box}")"
    containers+=("${container}")
    docker rm -f "${container}" >/dev/null 2>&1 || true
    echo "    systemd: $(boot_box "${container}" "${tag}")"
    if docker exec "${container}" timeout 180 node "/ms/${dist}/names-off.js" --case "${box}" \
      --image "${image}" >"${out}/off-${box}.json.partial" 2>"${out}/off-${box}.log"; then
      keep_run "off-${box}.json"
      sed 's/^/    /' "${out}/off-${box}.log"
    else
      mv "${out}/off-${box}.json.partial" "${out}/off-${box}.json.failed"
      echo "    FAILED: the off-${box} box stopped:" >&2
      tail -5 "${out}/off-${box}.log" | sed 's/^/      /' >&2
      failed=1
    fi
    docker rm -f "${container}" >/dev/null 2>&1 || true
  done <<<"${OFF_BOXES}"
fi

# The skew boxes (`P-462`, D28): a file edited under a running probe, then its helper SIGKILLed.
if want_box skew; then
  while read -r box image; do
    [ -n "${box}" ] || continue
    read -r base _ snapshot <<<"$(image_row "${image}")"
    if ! digest="$(base_digest "${image}" "${base}")"; then
      failed=1
      continue
    fi
    tag="ms-names-diff:${image}-skew-${box}"
    echo "==> skew box ${box}: building ${tag} from ${digest}"
    build_box "${tag}" "${digest}" 0 "${snapshot}" ""
    verify_image="${tag}"
    run_box "skew-${box}" "${tag}" timeout 200 node "/ms/${dist}/names-skew.js" --case "${box}" \
      --image "${image}"
  done <<<"${SKEW_BOXES}"
fi

echo "==> verifying every image's run against the rows, and every box"
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
