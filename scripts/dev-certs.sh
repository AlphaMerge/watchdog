#!/usr/bin/env bash
# Generate a development CA and the core/probe certificates for the mutual-TLS probe channel.
#
# Development only. A production install uses the operator's own PKI, or certificates issued by
# the core during probe enrolment (TASKS.md R-01).
#
#   scripts/dev-certs.sh [output-dir]     default: dev/tls
set -euo pipefail

out="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dev/tls}"
days=825

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

mkdir -p "${out}"
cd "${out}"

if [ -f ca.crt ] && [ -f core.crt ] && [ -f probe.crt ]; then
  echo "==> certificates already present in ${out} (delete them to regenerate)"
  exit 0
fi

echo "==> generating development CA in ${out}"
openssl req -x509 -newkey rsa:2048 -sha256 -days "${days}" -nodes \
  -keyout ca.key -out ca.crt \
  -subj "/CN=MonitoringSystem development CA/O=MonitoringSystem" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

issue() {
  local name="$1" cn="$2" ext="$3"
  echo "==> issuing ${name} certificate"
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "${name}.key" -out "${name}.csr" \
    -subj "/CN=${cn}/O=MonitoringSystem" 2>/dev/null
  openssl x509 -req -in "${name}.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "${name}.crt" -days "${days}" -sha256 \
    -extfile <(printf '%s\n' "${ext}") 2>/dev/null
  rm -f "${name}.csr"
  chmod 600 "${name}.key"
}

# The core is a TLS server: it needs a SAN the probe can match against.
issue core "ms-core" "$(cat <<'EXT'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:localhost,DNS:ms-core,IP:127.0.0.1,IP:::1
EXT
)"

# The probe is a TLS client: clientAuth only.
issue probe "ms-probe" "$(cat <<'EXT'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EXT
)"

chmod 600 ca.key
rm -f ca.srl

echo "==> done"
ls -1 "${out}"
