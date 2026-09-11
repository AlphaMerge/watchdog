#!/usr/bin/env bash
# Remote probe enrolment smoke test (TASKS.md R-07).
#
# Two clean systemd boxes on one network: a core on the first, a probe-only package on the
# second, enrolled across with a bundle carried between them exactly as an operator would. Then
# assert the probe connected, appeared in the approval queue by the name it was enrolled under,
# and was given nothing to scan until somebody approved it.
#
# **One box would prove nothing this needs proving.** The enrolment flow exists because the probe
# is somewhere else: a bundle that quietly depended on a file path only the core host has, a
# certificate with a SAN that only matches localhost, or a probe.json still pointing at 127.0.0.1
# all pass on a single host and fail on the day it matters.
#
# Development/CI only.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/api-auth.sh
. "${repo_root}/scripts/lib/api-auth.sh"
# shellcheck source=scripts/lib/smoke-names.sh
. "${repo_root}/scripts/lib/smoke-names.sh"
# Per-run, so a push and a hand-run do not delete each other's boxes mid-test (`P-200`).
core_box="$(ms_smoke_name core)"
probe_box="$(ms_smoke_name probe)"
network="$(ms_smoke_name net)"
image=ms-smoke:bookworm

# **Always the toolchain container, never the host's npm.** This script boots Docker containers,
# so Docker is a hard requirement and there is no situation where the host toolchain is the only
# option — while there is a common one where it is the wrong option: a workspace whose
# `node_modules` were installed inside the container carries native bindings for the container's
# platform, and building against them with the host's Node fails somewhere deep in a bundler.
#
# `$@` rather than a local array: bash 3.2 treats an empty array's expansion as unbound under
# `set -u`, and the full-package call passes no arguments at all.
package() {
  "${repo_root}/scripts/dev.sh" "scripts/package.sh $*" >/dev/null
}

echo "==> building both packages"
package
package --probe-only
# `ms-[0-9]*` rather than `ms-*`: the probe package is `ms-probe-…`, which `ms-*` also matches,
# and picking it up here would hand the core's installer a tarball with no core in it.
newest() {
  local newest='' candidate
  for candidate in "$@"; do
    [ -f "${candidate}" ] || continue
    if [ -z "${newest}" ] || [ "${candidate}" -nt "${newest}" ]; then newest="${candidate}"; fi
  done
  printf '%s' "${newest}"
}
core_tarball="$(newest "${repo_root}"/release/ms-[0-9]*.tar.gz)"
probe_tarball="$(newest "${repo_root}"/release/ms-probe-*.tar.gz)"
[ -f "${core_tarball}" ] || { echo "no core tarball built" >&2; exit 1; }
[ -f "${probe_tarball}" ] || { echo "no probe tarball built" >&2; exit 1; }
echo "    core:  $(basename "${core_tarball}")"
echo "    probe: $(basename "${probe_tarball}")"

cleanup() {
  docker rm -f "${core_box}" "${probe_box}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
ms_smoke_reap_orphans

echo "==> building smoke image"
docker build -q -t "${image}" "${repo_root}/scripts/smoke" >/dev/null

echo "==> booting two clean systemd boxes on one network"
docker network create --label ms-smoke "${network}" >/dev/null
for box in "${core_box}" "${probe_box}"; do
  # The labels are two separate arguments by design, so this expansion must split.
  # shellcheck disable=SC2046
  docker run -d --name "${box}" --hostname "${box}" --network "${network}" \
    $(ms_smoke_labels) \
    --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock \
    "${image}" >/dev/null
done

for box in "${core_box}" "${probe_box}"; do
  for _ in $(seq 1 60); do
    state="$(docker exec "${box}" systemctl is-system-running 2>/dev/null || true)"
    { [ "${state}" = "running" ] || [ "${state}" = "degraded" ]; } && break
    sleep 1
  done
  echo "    ${box}: $(docker exec "${box}" systemctl is-system-running 2>/dev/null || echo unknown)"
done

failed=0
note_failure() {
  echo "    $1" >&2
  failed=1
}

# **`grep -q` in a pipeline lies under `pipefail`**, the same way it did in `smoke-install.sh`
# before that script grew this helper: grep exits at the first match, the producer gets SIGPIPE
# and reports 141, and `pipefail` turns a *successful* match into a failed assertion whenever the
# producer had more to write. It matters more here than it did there, because one of the two uses
# below is a **negative** assertion — a spurious failure would not flake, it would quietly pass
# and stop catching the regression it exists to catch.
matches() {
  local pattern="$1"
  shift
  local output
  output="$("$@" 2>/dev/null || true)"
  printf '%s' "${output}" | grep -q -- "${pattern}"
}

# --- the core -----------------------------------------------------------------------------
echo "==> installing the core"
docker cp "${repo_root}/scripts/smoke/provision-postgres.sh" "${core_box}:/tmp/provision-postgres.sh"
docker exec "${core_box}" bash /tmp/provision-postgres.sh
docker cp "${core_tarball}" "${core_box}:/tmp/release.tar.gz"
docker exec "${core_box}" bash -c 'mkdir -p /tmp/unpacked && tar -xzf /tmp/release.tar.gz -C /tmp/unpacked'
docker exec "${core_box}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh --core-only --no-start'
docker cp "${repo_root}/scripts/smoke/configure-core.sh" "${core_box}:/tmp/configure-core.sh"
docker exec "${core_box}" bash /tmp/configure-core.sh

# The core binds a wildcard by default, which is right for a service and useless as an address
# to hand a probe. `ms-enrol` refuses to guess one, so the box's own name is what goes in.
docker exec "${core_box}" bash -c "
  node -e '
    const { readFileSync, writeFileSync } = require(\"node:fs\");
    const cfg = JSON.parse(readFileSync(\"/etc/ms/core.json\", \"utf8\"));
    cfg.probeEndpoint.host = \"0.0.0.0\";
    writeFileSync(\"/etc/ms/core.json\", JSON.stringify(cfg, null, 2) + \"\n\");
  '"
docker exec "${core_box}" systemctl start ms-core
sleep 2
state="$(docker exec "${core_box}" systemctl is-active ms-core || true)"
echo "    ms-core: ${state}"
[ "${state}" = "active" ] || {
  docker exec "${core_box}" journalctl -u ms-core --no-pager -n 40 || true
  echo "==> SMOKE TEST FAILED: the core did not start" >&2
  exit 1
}

# The core's certificate is issued by install.sh with a SAN for localhost and the box's own
# hostname, so the probe has to dial it by that name for TLS to verify at all. That is the
# realistic shape — an operator enrols against a name, not an address.
echo "==> issuing an enrolment bundle on the core"
docker exec "${core_box}" /opt/ms/bin/ms-enrol web-dc2 \
  --host "${core_box}" --out /tmp/web-dc2.enrol

echo "==> asserting the bundle is a bundle and not a surprise"
bundle_json="$(docker exec "${core_box}" cat /tmp/web-dc2.enrol)"
for field in '"bundleVersion": 1' '"probeName": "web-dc2"' '"accessKey"' '"ca"' '"cert"' '"key"'; do
  case "${bundle_json}" in
    *"${field}"*) : ;;
    *) note_failure "enrolment bundle is missing ${field}" ;;
  esac
done
# It carries a private key: it must not be world-readable even for the moment it exists.
mode="$(docker exec "${core_box}" stat -c '%a' /tmp/web-dc2.enrol)"
[ "${mode}" = "600" ] || note_failure "enrolment bundle is mode ${mode}, expected 600"

# **Each probe gets its own certificate.** Before R-07 there was one probe.crt on the core and
# every probe presented it, so this is the assertion the ticket exists for.
second="$(docker exec "${core_box}" bash -c '/opt/ms/bin/ms-enrol other-probe --host x --port 1 2>/dev/null')"
first_cert="$(printf '%s' "${bundle_json}" | sed -n 's/.*"cert": "\(.*\)",$/\1/p' | head -c 200)"
second_cert="$(printf '%s' "${second}" | sed -n 's/.*"cert": "\(.*\)",$/\1/p' | head -c 200)"
if [ -n "${first_cert}" ] && [ "${first_cert}" = "${second_cert}" ]; then
  note_failure "two enrolments produced the same certificate — probes are not individually revocable"
else
  echo "    per-probe certificate: ok"
fi

# --- the probe ----------------------------------------------------------------------------
echo "==> installing the probe on the other box"
docker cp "${core_box}:/tmp/web-dc2.enrol" "${repo_root}/build/web-dc2.enrol"
docker cp "${repo_root}/build/web-dc2.enrol" "${probe_box}:/tmp/web-dc2.enrol"
rm -f "${repo_root}/build/web-dc2.enrol"
docker cp "${probe_tarball}" "${probe_box}:/tmp/probe.tar.gz"
docker exec "${probe_box}" bash -c 'mkdir -p /tmp/unpacked && tar -xzf /tmp/probe.tar.gz -C /tmp/unpacked'
docker exec "${probe_box}" bash -c 'cd /tmp/unpacked/ms-probe-* && ./install-probe.sh --enrolment /tmp/web-dc2.enrol'

state="$(docker exec "${probe_box}" systemctl is-active ms-probe || true)"
echo "    ms-probe: ${state}"
[ "${state}" = "active" ] || {
  docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
  note_failure "the probe did not start"
}

echo "==> asserting there is no core on the probe host"
# The point of a probe-only package. A core service unit here would mean the operator can start
# one by accident on a machine with no database.
if docker exec "${probe_box}" test -e /etc/systemd/system/ms-core.service; then
  note_failure "a core unit was installed on the probe host"
else
  echo "    no ms-core unit: ok"
fi
if docker exec "${probe_box}" test -e /opt/ms/app/core; then
  note_failure "the core application was installed on the probe host"
else
  echo "    no core application: ok"
fi

echo "==> asserting the probe reached the core across the network"
connected=0
for _ in $(seq 1 30); do
  if matches 'connected to core' docker exec "${probe_box}" journalctl -u ms-probe --no-pager; then
    connected=1
    break
  fi
  sleep 1
done
if [ "${connected}" -eq 1 ]; then
  echo "    probe connected: ok"
else
  docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
  docker exec "${core_box}" journalctl -u ms-core --no-pager -n 40 || true
  note_failure "the probe never connected — mutual TLS across two hosts is what this proves"
fi

echo "==> asserting it is waiting for approval, under the name it was enrolled with"
# Authenticated: the shipped `core.json` leaves `api.requireAuthentication` at its default,
# which is on, and an unauthenticated read here answered 401 and reported the probe missing from
# a queue it was sitting in (`U-20`).
docker cp "${repo_root}/scripts/smoke/api-token.sh" "${core_box}:/tmp/api-token.sh"
MS_TOKEN="$(docker exec "${core_box}" bash /tmp/api-token.sh)"
export MS_TOKEN
probes_json="$(ms_docker_curl "${core_box}" -sf http://127.0.0.1:8080/api/v1/probes || true)"
case "${probes_json}" in
  *'"displayName":"web-dc2"'*) echo "    enrolled name reached the queue: ok" ;;
  *) note_failure "the probe is not in the queue as web-dc2: ${probes_json}" ;;
esac
case "${probes_json}" in
  *'"status":"pending"'*) echo "    waiting for approval: ok" ;;
  *) note_failure "the probe did not arrive pending — reaching the port is not being trusted (R-01)" ;;
esac

echo "==> asserting the core reports no version skew for a probe from the same build"
case "${probes_json}" in
  *'"kind":"current"'*) echo "    skew: current" ;;
  *) note_failure "the core reports a skew against a probe built from the same tree (R-06)" ;;
esac

echo "==> asserting an unapproved probe was given nothing to scan"
# R-01's claim, across two hosts this time: a probe that has connected is not a probe that may
# scan, and the door is the core's.
if matches 'applied configuration' docker exec "${probe_box}" journalctl -u ms-probe --no-pager; then
  note_failure "an unapproved probe was sent configuration"
else
  echo "    no configuration before approval: ok"
fi

# --- the decision has to reach the machine (`P-197`) -----------------------------------------
# **Approving and revoking are proved only by unit tests until here.** `main.ts` binds the
# registry to the endpoint with one line — `probeRegistry.attach(probeEndpoint)` — and both halves
# are unit-tested while the line joining them is not. `P-189` and `P-196` were each a decision
# that wrote its rows and never reached the probe, which is exactly the class of defect a unit
# test cannot see. It goes here rather than in `smoke-install.sh` because approving binds a probe
# to a branch and issues it a key in the welcome, and a bundle that quietly depended on a path
# only the core host has is the failure this file exists to catch.

# Reads one field out of a JSON body on stdin, using the *box's* node. `curl | node` rather than
# `sed`, because a regex over JSON is a test that passes until somebody reorders a field — and the
# box's node rather than the host's, because this repository's toolchain is in a container
# (`scripts/dev.sh`) and the host may have no node at all.
field() { docker exec -i "${core_box}" node -pe "JSON.parse(require('node:fs').readFileSync(0,'utf8'))$1"; }

# How many times a pattern appears, so "it happened again" can be told from "it happened once".
# `grep -c` exits 1 on no match, which `set -e` would take as a failure rather than as zero.
occurrences() {
  local pattern="$1"
  shift
  local output
  output="$("$@" 2>/dev/null || true)"
  printf '%s' "${output}" | grep -c -- "${pattern}" || true
}

restarts() { docker exec "${probe_box}" systemctl show ms-probe -p NRestarts --value | tr -d '\r'; }

# **The restart count is half of every assertion below.** Bouncing the service would prove the
# handshake works, which was never in doubt, and would hide whether the decision reached a live
# connection — which is the whole of `P-189` and `P-196`.
before_restarts="$(restarts)"

echo "==> approving the probe onto a branch of the tree"
api=http://127.0.0.1:8080/api/v1
# The probe is already in the queue — the block above asserted it — but poll anyway, because the
# gid is what every call below needs and a race here would read exactly like the bug this exists
# to catch. `|| true` inside the substitution: under `pipefail` a core that has not answered yet
# would end the script instead of being retried, and stderr is silenced on this one call so an
# expected non-answer does not print a parser stack trace that reads like a crash.
gid=''
for _ in $(seq 1 30); do
  gid="$(ms_docker_curl "${core_box}" -sf "${api}/probes?status=pending" 2>/dev/null | field ".items[0]?.gid ?? ''" 2>/dev/null || true)"
  [ -n "${gid}" ] && break
  sleep 1
done
[ -n "${gid}" ] || { note_failure "no probe is waiting for approval"; gid=''; }

if [ -n "${gid}" ]; then
  # The branch it is approved onto. Created here rather than by the installer: a probe object with
  # no probe behind it is a branch of the tree an operator did not ask for.
  root="$(ms_docker_curl "${core_box}" -sf "${api}/objects/root" | field '.id')"
  probe_object="$(ms_docker_curl "${core_box}" -sf -X POST "${api}/objects" \
    -H 'content-type: application/json' \
    -d "{\"kind\":\"probe\",\"parentId\":${root},\"name\":\"web-dc2\"}" | field '.id')"

  # `local: false`, and it is the truth rather than a default: this probe is on the other box.
  ms_docker_curl "${core_box}" -sf -X POST "${api}/probes/${gid}/approve" \
    -H 'content-type: application/json' \
    -d "{\"objectId\":${probe_object},\"local\":false}" >/dev/null
  echo "    approved ${gid} onto probe object ${probe_object}"

  echo "==> asserting the approval reached the probe, without restarting it"
  applied=0
  for _ in $(seq 1 60); do
    if matches 'applied configuration' docker exec "${probe_box}" journalctl -u ms-probe --no-pager; then
      applied=1
      break
    fi
    sleep 1
  done
  if [ "${applied}" -eq 1 ]; then
    echo "    configuration applied after approval: ok"
  else
    docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
    docker exec "${core_box}" journalctl -u ms-core --no-pager -n 40 || true
    note_failure "the probe was approved and never applied a configuration (P-189)"
  fi
  now_restarts="$(restarts)"
  if [ "${now_restarts}" = "${before_restarts}" ]; then
    echo "    ms-probe restarts still ${now_restarts}: ok"
  else
    note_failure "the probe restarted (${before_restarts} -> ${now_restarts}) — a bounce proves the handshake, not the decision"
  fi

  # --- and so does withdrawing it ------------------------------------------------------------
  # Order matters: `stopped scanning` is only meaningful after `applied configuration`, so this
  # block has to follow the one above and anything that stops the probe has to follow both.
  echo "==> revoking it with a note, and asserting the machine stops"
  # **Everything below reads only the journal written after this point.** `stopped scanning` and
  # the operator's sentence both appear on the pre-`P-196` path as well — a bare close makes the
  # probe reconnect, and the handshake it comes back on is refused with the same code and the same
  # sentence — so a test that greps the whole journal for either of them passes with `withdraw`
  # replaced by `disconnect`. Measured: that mutation survived the first version of this block.
  # What tells them apart is whether the probe had to reconnect to find out, which is the whole of
  # `P-196`, and that is an ordering question inside this slice.
  cursor="$(docker exec "${probe_box}" bash -c "journalctl -u ms-probe --no-pager -n 0 --show-cursor 2>/dev/null | sed -n 's/^-- cursor: //p'")"
  # Reads `${cursor}` when it is called, not when it is defined, so re-stamping the cursor before
  # a later step re-points this at that step's slice. The `allow-from` block below relies on it.
  since_cursor() { docker exec "${probe_box}" journalctl -u ms-probe --no-pager --after-cursor "${cursor}" 2>/dev/null || true; }

  revoke_note='decommissioned by the smoke test'
  ms_docker_curl "${core_box}" -sf -X POST "${api}/probes/${gid}/revoke" \
    -H 'content-type: application/json' \
    -d "{\"note\":\"${revoke_note}\"}" >/dev/null

  stopped=0
  for _ in $(seq 1 60); do
    if printf '%s' "$(since_cursor)" | grep -q 'stopped scanning'; then
      stopped=1
      break
    fi
    sleep 1
  done
  slice="$(since_cursor)"
  if [ "${stopped}" -eq 1 ]; then
    echo "    probe stopped scanning: ok"
  else
    docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
    note_failure "a revoked probe kept its assignments — it goes on probing the network until its process dies (P-196)"
  fi

  # **On the connection it already had.** `withdraw` sends a `reject` down the open link and then
  # closes it, so the probe stops and *then* notices the close. A bare `disconnect` is the other
  # order: the link drops, the probe treats it as the blip it is built to survive, and it only
  # learns it is refused at the next handshake — hours away on a real network, a second away here,
  # which is exactly why asserting on the outcome alone proves nothing.
  stop_at="$(printf '%s' "${slice}" | grep -n 'stopped scanning' | head -1 | cut -d: -f1)"
  close_at="$(printf '%s' "${slice}" | grep -n 'link to core closed' | head -1 | cut -d: -f1)"
  if [ -z "${stop_at}" ]; then
    : # already reported above
  elif [ -z "${close_at}" ] || [ "${stop_at}" -lt "${close_at}" ]; then
    echo "    it stopped without reconnecting first: ok"
  else
    note_failure "the probe only stopped after the link dropped and it came back — the decision did not reach the live connection (P-196)"
  fi

  # **The operator's own sentence, not the word "revoked".** "Decommissioned, replaced by web-dc4"
  # tells whoever reads the probe's journal everything and "revoked" tells them nothing. This one
  # is about the *content* of the refusal and deliberately not about the mechanism — the same
  # sentence travels on a refused handshake, which is what the ordering check above is for.
  if printf '%s' "${slice}" | grep -q -- "${revoke_note}"; then
    echo "    the operator's reason reached the probe: ok"
  else
    note_failure "the probe was told it was refused and not why — the note never left the core"
  fi

  now_restarts="$(restarts)"
  if [ "${now_restarts}" = "${before_restarts}" ]; then
    echo "    ms-probe restarts still ${now_restarts}: ok"
  else
    note_failure "the probe restarted during revocation (${before_restarts} -> ${now_restarts})"
  fi

  # --- and it can be let back in ------------------------------------------------------------
  # The only end-to-end check on `P-37`: revoking cleared `access_key_hash`, so coming back means
  # presenting the *enrolment* key from the bundle and being issued a fresh one in the welcome.
  # Nothing but a second machine and a real handshake exercises that.
  echo "==> re-approving, and asserting it comes back on a freshly issued key"
  applied_before="$(occurrences 'applied configuration' docker exec "${probe_box}" journalctl -u ms-probe --no-pager)"
  ms_docker_curl "${core_box}" -sf -X POST "${api}/probes/${gid}/approve" \
    -H 'content-type: application/json' \
    -d "{\"objectId\":${probe_object},\"local\":false}" >/dev/null

  # Up to 90 s: every rejected reconnect widened the backoff, which tops out at 60 s.
  came_back=0
  for _ in $(seq 1 90); do
    applied_now="$(occurrences 'applied configuration' docker exec "${probe_box}" journalctl -u ms-probe --no-pager)"
    if [ "${applied_now}" -gt "${applied_before}" ]; then
      came_back=1
      break
    fi
    sleep 1
  done
  if [ "${came_back}" -eq 1 ]; then
    echo "    re-approved probe applied a configuration again: ok"
  else
    docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
    note_failure "a re-approved probe never came back — its key hash was cleared and nothing reissued one (P-37)"
  fi

  # **Read from the database rather than from `hasOwnKey`, and the difference is the point.**
  # The API's `hasOwnKey` is `access_key_hash AND access_key_confirmed_at`, and confirmation is
  # written when the probe *presents* the key — the handshake after the one that issued it. So it
  # is false here by design, on a link that is up and working, and asserting it would be asserting
  # something the core deliberately does not claim yet: it knowing a key and the probe having it
  # are different facts (`P-37`). What this step can prove is that a key was issued at all, which
  # is what revoking cleared.
  issued="$(docker exec "${core_box}" su postgres -c \
    "psql -d monitoring -tAc \"SELECT access_key_hash IS NOT NULL FROM probe_registration WHERE gid = '${gid}'\"" | tr -d '[:space:]')"
  if [ "${issued}" = "t" ]; then
    echo "    the core issued it a fresh key in the welcome: ok"
  else
    note_failure "a re-approved probe was issued no key — revoking cleared the hash and nothing replaced it (P-37)"
  fi

  # --- narrowing where it may connect from (`P-199`) ------------------------------------------
  # **Last, because it stops the probe for good.** `P-197` said a block that does this has to
  # follow the others or it hollows them out, and this one cannot be undone from here: once the
  # filter excludes the probe, every handshake it makes is refused.
  #
  # `revoke` above proved `withdraw` reaches a live connection. This proves the *other* thing
  # `P-197` named as unreached by anything running the real services: `remoteAddressOf`. It is
  # only used here, it is the one input to the decision, and returning `null` from it makes the
  # whole withdrawal a silent no-op — the probe keeps scanning from an address the operator has
  # just excluded, and nothing anywhere says so. Two boxes are what make it real: on one host the
  # address would be loopback and prove nothing about a filter.
  echo "==> narrowing the address filter, and asserting it only bites when it should"
  address="$(ms_docker_curl "${core_box}" -sf "${api}/probes" | field ".items.find((p) => p.gid === '${gid}')?.lastAddress ?? ''")"
  if [ -z "${address}" ]; then
    note_failure "the core recorded no address for a probe it is talking to (P-199)"
  else
    echo "    connected from ${address}"

    narrow() {
      ms_docker_curl "${core_box}" -sf -X PUT "${api}/probes/${gid}/allow-from" \
        -H 'content-type: application/json' -d "$1" >/dev/null
    }

    # **The half a naive implementation gets wrong.** Tightening a range around the machines
    # already inside it is the ordinary case and must cost nothing — an implementation that
    # withdraws on every edit passes the negative case below and fails here.
    cursor="$(docker exec "${probe_box}" bash -c "journalctl -u ms-probe --no-pager -n 0 --show-cursor 2>/dev/null | sed -n 's/^-- cursor: //p'")"
    narrow "{\"allowFrom\":[\"${address}\"]}"
    sleep 5
    if printf '%s' "$(since_cursor)" | grep -q 'stopped scanning'; then
      note_failure "a filter that still covers the probe stopped it anyway (P-199)"
    else
      echo "    a filter that still covers it costs nothing: ok"
    fi

    # TEST-NET-1, which no Docker network hands out, so this excludes the probe wherever it ran.
    cursor="$(docker exec "${probe_box}" bash -c "journalctl -u ms-probe --no-pager -n 0 --show-cursor 2>/dev/null | sed -n 's/^-- cursor: //p'")"
    narrow '{"allowFrom":["192.0.2.0/24"]}'

    excluded=0
    for _ in $(seq 1 60); do
      if printf '%s' "$(since_cursor)" | grep -q 'stopped scanning'; then
        excluded=1
        break
      fi
      sleep 1
    done
    slice="$(since_cursor)"
    if [ "${excluded}" -eq 1 ]; then
      echo "    a filter that excludes it stops it: ok"
    else
      docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 30 || true
      note_failure "the probe kept scanning from an address its operator had just excluded (P-199)"
    fi

    # The same ordering question as the revocation: on the live connection, or only after the
    # link dropped and it came back?
    stop_at="$(printf '%s' "${slice}" | grep -n 'stopped scanning' | head -1 | cut -d: -f1)"
    close_at="$(printf '%s' "${slice}" | grep -n 'link to core closed' | head -1 | cut -d: -f1)"
    if [ -z "${stop_at}" ]; then
      : # already reported above
    elif [ -z "${close_at}" ] || [ "${stop_at}" -lt "${close_at}" ]; then
      echo "    it stopped without reconnecting first: ok"
    else
      note_failure "the filter only bit at the next handshake, not on the live connection (P-196)"
    fi

    # **The address itself has to reach the probe**, and that is what says `remoteAddressOf`
    # answered rather than returning null: the core builds "this probe is not accepted from
    # <address>" out of the live socket, so its own address coming back in its own journal is the
    # end-to-end proof that the lookup worked.
    if printf '%s' "${slice}" | grep -q -- "${address}"; then
      echo "    it was told which address was refused: ok"
    else
      note_failure "the probe was refused without being told from where — remoteAddressOf (P-199)"
    fi
  fi
fi

echo "==> asserting a re-run keeps the operator's configuration"
docker exec "${probe_box}" bash -c "
  node -e '
    const { readFileSync, writeFileSync } = require(\"node:fs\");
    const cfg = JSON.parse(readFileSync(\"/etc/ms/probe.json\", \"utf8\"));
    cfg.probe.checkQueueMaxLength = 4242;
    writeFileSync(\"/etc/ms/probe.json\", JSON.stringify(cfg, null, 2) + \"\n\");
  '"
docker exec "${probe_box}" bash -c 'cd /tmp/unpacked/ms-probe-* && ./install-probe.sh --no-start' >/dev/null
kept="$(docker exec "${probe_box}" node -p 'JSON.parse(require("node:fs").readFileSync("/etc/ms/probe.json","utf8")).probe.checkQueueMaxLength')"
if [ "${kept}" = "4242" ]; then
  echo "    upgrade kept probe.json: ok"
else
  note_failure "an upgrade overwrote the operator's configuration (checkQueueMaxLength is ${kept})"
fi

echo "==> asserting the installer refuses an unusable bundle rather than half-installing"
docker exec "${probe_box}" bash -c 'printf "{\"bundleVersion\":1}" > /tmp/broken.enrol'
if docker exec "${probe_box}" bash -c 'cd /tmp/unpacked/ms-probe-* && ./install-probe.sh --enrolment /tmp/broken.enrol' >/dev/null 2>&1; then
  note_failure "the installer accepted an incomplete enrolment bundle"
else
  echo "    incomplete bundle refused: ok"
fi

if [ "${failed}" -ne 0 ]; then
  echo "==> SMOKE TEST FAILED" >&2
  exit 1
fi
echo "==> enrolment smoke test passed"
