#!/usr/bin/env bash
# Backup and restore smoke test (TASKS.md H-04): back an installation up, then restore it onto a
# **different, clean host** and assert that what comes back is what went in.
#
# Two containers, not one, and that is the point. Restoring over the installation the backup came
# from proves almost nothing — the data is already there, the vault key is already there, the
# certificates are already there, and a restore that quietly did nothing would pass. The question
# an operator actually needs answered is "the machine is gone; can I rebuild it", and only a
# second box asks it.
#
# What is asserted on the far side:
#   - the object tree, by name and shape;
#   - a **credential**, by both of its inputs — the vault key and the stored ciphertext, each
#     byte-identical on the far side. That pair yielding the plaintext is the vault's own
#     property; what a backup gets wrong is losing or substituting one of them;
#   - historical readings, which are the bulk of the database and the part a dump can truncate;
#   - the schema, by starting the service rather than by counting tables.
#
# Development/CI only.
set -euo pipefail

matches() {
  local pattern="$1"
  shift
  local output
  output="$("$@" 2>/dev/null || true)"
  printf '%s' "${output}" | grep -q -- "${pattern}"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/api-auth.sh
. "${repo_root}/scripts/lib/api-auth.sh"
origin=ms-smoke-backup-origin
target=ms-smoke-backup-target
image=ms-smoke:bookworm
failed=0

if [ "$#" -gt 0 ]; then
  tarball="$1"
  [ -f "${tarball}" ] || { echo "no such tarball: ${tarball}" >&2; exit 1; }
  echo "==> using the tarball given on the command line"
else
  echo "==> building a release tarball"
  if [ "${MS_SMOKE_HOST_NPM:-0}" = "1" ]; then
    "${repo_root}/scripts/package.sh" >/dev/null
  else
    "${repo_root}/scripts/dev.sh" "scripts/package.sh" >/dev/null
  fi
  tarball="$(ls -t "${repo_root}"/release/ms-*.tar.gz 2>/dev/null | head -1)"
  [ -n "${tarball}" ] || { echo "scripts/package.sh produced no tarball" >&2; exit 1; }
fi
echo "    ${tarball}"

cleanup() {
  docker rm -f "${origin}" "${target}" >/dev/null 2>&1 || true
  rm -f /tmp/ms-smoke-backup.tar.gz
}
trap cleanup EXIT

docker build -q -t "${image}" "${repo_root}/scripts/smoke" >/dev/null

boot() {
  local name="$1"
  docker rm -f "${name}" >/dev/null 2>&1 || true
  # The same invocation `smoke-install.sh` uses, including `--cgroupns=host` and letting the
  # image's own entrypoint be init — without those systemd never finishes booting.
  docker run -d --name "${name}" \
    --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock \
    "${image}" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "${name}" systemctl is-system-running --wait >/dev/null 2>&1; then return 0; fi
    state="$(docker exec "${name}" systemctl is-system-running 2>/dev/null || true)"
    case "${state}" in running|degraded) return 0 ;; esac
    sleep 1
  done
  echo "systemd never came up in ${name}" >&2
  return 1
}

install_into() {
  local name="$1"
  docker cp "${repo_root}/scripts/smoke/provision-postgres.sh" "${name}:/tmp/provision-postgres.sh"
  docker exec "${name}" bash /tmp/provision-postgres.sh >/dev/null
  docker cp "${tarball}" "${name}:/tmp/release.tar.gz"
  docker exec "${name}" bash -c 'mkdir -p /tmp/unpacked && tar -xzf /tmp/release.tar.gz -C /tmp/unpacked'
  docker exec "${name}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh --no-start' >/dev/null
  docker cp "${repo_root}/scripts/smoke/configure-core.sh" "${name}:/tmp/configure-core.sh"
  docker exec "${name}" bash /tmp/configure-core.sh >/dev/null
}

# **One token, minted from the origin, used on both hosts** (`U-20`). The shipped `core.json`
# does not set `api.requireAuthentication`, so it defaults to on and every call below needs a
# credential. The target does not need one of its own: by the time anything here asks it a
# question it is running on the origin's restored database, accounts and all — which is a
# property of the restore worth leaning on, since a token that stopped working across it would
# mean the accounts had not come back.
api() {
  local name="$1"
  shift
  ms_docker_curl "${name}" -sf "$@"
}

# ── the installation that is about to be lost ────────────────────────────────────────────────

echo "==> booting the origin host"
boot "${origin}"
install_into "${origin}"
docker exec "${origin}" systemctl start ms-core
for _ in $(seq 1 30); do
  # Unauthenticated on purpose: this is a readiness wait, and a 401 is as good an answer as a
  # 200 for "the API is listening". The token cannot be minted until it is.
  docker exec "${origin}" curl -s -o /dev/null http://127.0.0.1:8080/api/v1/objects/root 2>/dev/null && break
  sleep 1
done

docker cp "${repo_root}/scripts/smoke/api-token.sh" "${origin}:/tmp/api-token.sh"
MS_TOKEN="$(docker exec "${origin}" bash /tmp/api-token.sh)"
export MS_TOKEN

echo "==> creating something worth losing"
probe_id="$(api "${origin}" -X POST http://127.0.0.1:8080/api/v1/objects \
  -H 'content-type: application/json' \
  -d '{"kind":"probe","parentId":1,"name":"Backup probe"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
device_id="$(api "${origin}" -X POST http://127.0.0.1:8080/api/v1/objects \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"device\",\"parentId\":${probe_id},\"name\":\"Backup device\",\"host\":\"192.0.2.77\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
sensor_id="$(api "${origin}" -X POST http://127.0.0.1:8080/api/v1/objects \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"sensor\",\"parentId\":${device_id},\"name\":\"Backup sensor\",\"sensorType\":\"icmp.ping\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"

# **A credential**, which is the part of a backup that cannot be reconstructed by hand. It is
# encrypted with the vault key; if the key does not come back, this comes back as noise.
api "${origin}" -X PUT "http://127.0.0.1:8080/api/v1/objects/${device_id}/credentials/snmp" \
  -H 'content-type: application/json' \
  -d '{"values":{"version":"v2c","community":"the-secret-that-must-survive"}}' >/dev/null
echo "    probe ${probe_id}, device ${device_id}, sensor ${sensor_id}, one SNMP credential"

# Readings, so the dump is carrying a hypertable rather than an empty one.
docker exec "${origin}" su postgres -c "psql -d monitoring -c \"
  INSERT INTO channel (sensor_id, key, name, unit) VALUES (${sensor_id}, 'rtt', 'Response time', 'ms')
  ON CONFLICT DO NOTHING;
  INSERT INTO sample (channel_id, time, value)
  SELECT c.id, now() - (n || ' minutes')::interval, n
  FROM channel c, generate_series(1, 500) AS n WHERE c.sensor_id = ${sensor_id} AND c.key = 'rtt'
  ON CONFLICT DO NOTHING;\"" >/dev/null
samples_before="$(docker exec "${origin}" su postgres -c "psql -d monitoring -tAc 'SELECT count(*) FROM sample'")"
echo "    ${samples_before} readings"

echo "==> taking a backup"
docker exec "${origin}" systemctl stop ms-core
docker exec "${origin}" /opt/ms/bin/ms-backup --out /var/backups/ms >/dev/null
archive="$(docker exec "${origin}" bash -c 'ls -t /var/backups/ms/*.tar.gz | head -1')"
perms="$(docker exec "${origin}" stat -c '%a' "${archive}")"
if [ "${perms}" = "600" ]; then
  echo "    ${archive} (0600)"
else
  echo "    FAILED — the archive is mode ${perms}; it decrypts every credential in the installation" >&2
  failed=1
fi
docker cp "${origin}:${archive}" /tmp/ms-smoke-backup.tar.gz

# ── a different machine, which has never seen this installation ──────────────────────────────

echo "==> booting a clean target host"
boot "${target}"
install_into "${target}"

echo "==> restoring onto it"
docker cp /tmp/ms-smoke-backup.tar.gz "${target}:/tmp/restore.tar.gz"
# The target was installed but never started, so its database is empty and this should succeed
# outright. A refusal is only correct if the database has tables in it, and the message says so.
if docker exec "${target}" /opt/ms/bin/ms-restore /tmp/restore.tar.gz > /tmp/restore.log 2>&1; then
  echo "    restored"
elif grep -q 'already has' /tmp/restore.log; then
  echo "    refused a populated database, as designed — emptying it and retrying"
  docker exec "${target}" su postgres -c \
    "psql -d monitoring -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'" >/dev/null
  if docker exec "${target}" /opt/ms/bin/ms-restore /tmp/restore.tar.gz >/tmp/restore.log 2>&1; then
    echo "    restored"
  else
    echo "    FAILED — restore failed on an empty database:" >&2
    sed 's/^/      /' /tmp/restore.log >&2
    failed=1
  fi
else
  echo "    FAILED — restore did not succeed:" >&2
  sed 's/^/      /' /tmp/restore.log >&2
  failed=1
fi

echo "==> asserting a restore refuses to run under a live service"
# The first step of the procedure, and the one whose absence would be silent: restoring under a
# running core would have it writing into a database being replaced beneath it.
docker exec "${target}" systemctl start ms-core >/dev/null 2>&1 || true
sleep 2
if docker exec "${target}" /opt/ms/bin/ms-restore /tmp/restore.tar.gz >/tmp/refuse.log 2>&1; then
  echo "    FAILED — restore ran with ms-core active" >&2
  failed=1
else
  if grep -q 'is running' /tmp/refuse.log; then
    echo "    refused while ms-core was active"
  else
    echo "    FAILED — it refused for the wrong reason:" >&2
    sed 's/^/      /' /tmp/refuse.log >&2
    failed=1
  fi
fi
docker exec "${target}" systemctl stop ms-core >/dev/null 2>&1 || true

echo "==> starting the restored installation"
docker exec "${target}" systemctl start ms-core
for _ in $(seq 1 30); do
  api "${target}" http://127.0.0.1:8080/api/v1/objects/root >/dev/null 2>&1 && break
  sleep 1
done
state="$(docker exec "${target}" systemctl is-active ms-core 2>/dev/null || true)"
if [ "${state}" = "active" ]; then
  echo "    ms-core: active against the restored schema"
else
  echo "    FAILED — ms-core did not start on the restored database" >&2
  docker exec "${target}" journalctl -u ms-core --no-pager -n 40 || true
  failed=1
fi

echo "==> asserting the object tree came back"
if matches 'Backup sensor' api "${target}" "http://127.0.0.1:8080/api/v1/objects/${sensor_id}"; then
  echo "    sensor ${sensor_id}: present, by the same id"
else
  echo "    FAILED — the sensor is not there" >&2
  failed=1
fi

echo "==> asserting the readings came back"
samples_after="$(docker exec "${target}" su postgres -c "psql -d monitoring -tAc 'SELECT count(*) FROM sample'" || echo 0)"
if [ "${samples_after}" = "${samples_before}" ]; then
  echo "    ${samples_after} readings, unchanged"
else
  echo "    FAILED — ${samples_before} readings went in, ${samples_after} came back" >&2
  failed=1
fi

echo "==> asserting the credential can still be decrypted"
# **The part of a backup that cannot be reconstructed by hand**, and the reason the vault key is
# in the archive at all. No API returns a credential to anyone (CLAUDE.md), so rather than
# reimplementing decryption here this asserts the two inputs to it are byte-identical on both
# hosts: the key file, and the stored ciphertext. That the pair yields the plaintext is the
# vault's own property, tested in `vault-crypto.test.ts`; what a backup can get wrong is losing
# or substituting either one, and that is exactly what these two comparisons see.
key_origin="$(docker exec "${origin}" sha256sum /var/lib/ms-core/vault.key | cut -d' ' -f1)"
key_target="$(docker exec "${target}" sha256sum /var/lib/ms-core/vault.key | cut -d' ' -f1)"
if [ -n "${key_origin}" ] && [ "${key_origin}" = "${key_target}" ]; then
  echo "    vault key: identical"
else
  echo "    FAILED — the vault key differs; every stored credential is unrecoverable" >&2
  echo "      origin ${key_origin} target ${key_target}" >&2
  failed=1
fi

secret_sql="SELECT md5(secret::text) FROM credential_set WHERE object_id = ${device_id}"
cipher_origin="$(docker exec "${origin}" su postgres -c "psql -d monitoring -tAc \"${secret_sql}\"" || true)"
cipher_target="$(docker exec "${target}" su postgres -c "psql -d monitoring -tAc \"${secret_sql}\"" || true)"
if [ -n "${cipher_origin}" ] && [ "${cipher_origin}" = "${cipher_target}" ]; then
  echo "    stored ciphertext: identical"
else
  echo "    FAILED — the encrypted credential did not survive the dump" >&2
  echo "      origin '${cipher_origin}' target '${cipher_target}'" >&2
  failed=1
fi

if [ "${failed}" -ne 0 ]; then
  echo "==> BACKUP/RESTORE SMOKE TEST FAILED" >&2
  exit 1
fi
echo "==> backup and restore smoke test passed"
