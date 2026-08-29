#!/usr/bin/env bash
# MonitoringSystem installer for Linux (systemd).
#
# Run from inside an unpacked release tarball:
#     sudo ./install.sh                 # install both services
#     sudo ./install.sh --probe-only    # remote probe host
#     sudo ./install.sh --no-start      # install but do not start
#
# Creates the service users, lays out /opt/ms, /etc/ms and /var/lib, installs the units and
# starts the services. Re-running upgrades in place: configuration under /etc/ms is never
# overwritten.
set -euo pipefail

PREFIX=/opt/ms
CONFDIR=/etc/ms
components=(core probe)
start_services=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe-only) components=(probe) ;;
    --core-only)  components=(core) ;;
    --no-start)   start_services=0 ;;
    --prefix)     PREFIX="$2"; shift ;;
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(cat "${here}/VERSION")"

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

# This script runs as root and removes directories under $PREFIX. Refuse anything that could
# turn `rm -rf "${PREFIX}/bin"` into `rm -rf /bin`.
case "${PREFIX}" in
  /|'') die "refusing to install to '${PREFIX}'" ;;
  /*) : ;;
  *) die "--prefix must be an absolute path (got '${PREFIX}')" ;;
esac
command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)"
command -v node >/dev/null 2>&1 || die "Node.js is required on PATH"
command -v openssl >/dev/null 2>&1 || die "openssl is required (used to issue the probe-channel certificates)"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

echo "==> installing MonitoringSystem ${version} to ${PREFIX}"

# --- application ---------------------------------------------------------------------------
install -d -m 0755 "${PREFIX}"
rm -rf "${PREFIX:?}/app" "${PREFIX:?}/bin" "${PREFIX:?}/web"
cp -R "${here}/app" "${PREFIX}/app"
cp -R "${here}/bin" "${PREFIX}/bin"
chmod +x "${PREFIX}"/bin/*
# The web UI, served by ms-core from api.webRoot. Optional: a tarball built without it, or a
# deliberately headless install, simply leaves webRoot empty and no UI is served.
if [ -d "${here}/web" ]; then
  cp -R "${here}/web" "${PREFIX}/web"
fi
printf '%s\n' "${version}" > "${PREFIX}/VERSION"

install -d -m 0755 "${CONFDIR}"
# 0755: the directory must be traversable by every service user. What is secret here are the
# private keys, and they are protected per file below.
install -d -m 0755 "${CONFDIR}/tls"

# --- probe-channel PKI ---------------------------------------------------------------------
# The core and its probes speak mutual TLS (WORKFLOW.MD §10), so a working install needs a CA
# and a key pair for each side. We issue them here rather than making the operator do it: an
# install that will not start until you have read an OpenSSL manual is not an install.
# Replace these with your own PKI if you have one; probe enrolment gets a proper flow in R-01.
if [ ! -f "${CONFDIR}/tls/ca.crt" ]; then
  echo "==> issuing probe-channel certificates"
  hostname_fqdn="$(hostname -f 2>/dev/null || hostname)"
  (
    umask 077
    cd "${CONFDIR}/tls"

    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout ca.key -out ca.crt \
      -subj "/CN=MonitoringSystem probe CA/O=MonitoringSystem" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

    issue_cert() {
      local name="$1" cn="$2"
      openssl req -newkey rsa:2048 -sha256 -nodes \
        -keyout "${name}.key" -out "${name}.csr" \
        -subj "/CN=${cn}/O=MonitoringSystem" 2>/dev/null
      openssl x509 -req -in "${name}.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
        -out "${name}.crt" -days 825 -sha256 -extfile "${name}.ext" 2>/dev/null
      rm -f "${name}.csr" "${name}.ext"
    }

    cat > core.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:localhost,DNS:${hostname_fqdn},IP:127.0.0.1
EXT
    issue_cert core "ms-core"

    cat > probe.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EXT
    issue_cert probe "ms-probe"

    rm -f ca.srl
  )
  # A CA certificate is public by definition; both services and any operator need to read it.
  chmod 644 "${CONFDIR}/tls/ca.crt"
  chmod 640 "${CONFDIR}"/tls/core.crt "${CONFDIR}"/tls/probe.crt
  chmod 600 "${CONFDIR}"/tls/*.key
fi

# A shared secret the probe presents alongside its certificate (CAPABILITIES.MD §8). Generated
# once; remote probes are given it at enrolment.
if [ ! -f "${CONFDIR}/access-key" ]; then
  ( umask 077; openssl rand -hex 32 > "${CONFDIR}/access-key" )
fi
access_key="$(cat "${CONFDIR}/access-key")"

for svc in "${components[@]}"; do
  user="ms-${svc}"

  if ! getent passwd "${user}" >/dev/null; then
    echo "==> creating service user ${user}"
    useradd --system --no-create-home --home-dir "/var/lib/${user}" \
            --shell /usr/sbin/nologin --comment "MonitoringSystem ${svc}" "${user}"
  fi

  install -d -m 0750 -o "${user}" -g "${user}" "/var/lib/${user}"
  install -d -m 0750 -o "${user}" -g "${user}" "/var/log/${user}"

  # Each side reads its own key pair and nothing else; the CA certificate is world-readable.
  chgrp "${user}" "${CONFDIR}/tls/${svc}.crt" "${CONFDIR}/tls/${svc}.key"
  chmod 640 "${CONFDIR}/tls/${svc}.crt" "${CONFDIR}/tls/${svc}.key"

  # Configuration is never clobbered on upgrade.
  if [ -f "${CONFDIR}/${svc}.json" ]; then
    echo "==> keeping existing ${CONFDIR}/${svc}.json"
    # A timestamped copy before anything else touches this directory (H-03). Nothing here edits
    # the file, so this is not undoing our own change — it is the copy an operator wants when
    # *their* edit, made to satisfy the new build, turns out to be the thing that broke it.
    # Owned by root and mode 0600: a configuration file holds the database password.
    backup="${CONFDIR}/${svc}.json.$(date -u +%Y%m%dT%H%M%SZ).bak"
    install -m 0600 -o root -g root "${CONFDIR}/${svc}.json" "${backup}"
    echo "    backed up to ${backup}"
    install -m 0640 -o root -g "${user}" "${here}/etc/${svc}.json" "${CONFDIR}/${svc}.json.new"
  else
    echo "==> installing ${CONFDIR}/${svc}.json"
    install -m 0640 -o root -g "${user}" "${here}/etc/${svc}.json" "${CONFDIR}/${svc}.json"
    # Wire the generated access key into a freshly installed configuration.
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      const [path, key, svc] = process.argv.slice(1);
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (svc === "core") cfg.probeEndpoint.accessKeys = [key];
      else cfg.core.accessKey = key;
      writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    ' "${CONFDIR}/${svc}.json" "${access_key}" "${svc}"
  fi

  install -m 0644 "${here}/deploy/systemd/ms-${svc}.service" "/etc/systemd/system/ms-${svc}.service"
done

if [ -d "${here}/../docs" ]; then
  rm -rf "${PREFIX:?}/docs"
  cp -R "${here}/../docs" "${PREFIX}/docs"
fi

# --- will the configuration this installation already has load under the new build? ---------
#
# **Asked before anything is restarted**, which is the whole point: the old service is still
# running, so a setting that was renamed or made required is something an operator finds out
# about while they still have a working system rather than from `journalctl` afterwards
# (`H-03`). A `.json.new` sits beside each file for the diff.
#
# `--no-start` skips it: that mode exists for a machine that is being staged, and the
# configuration it will run with is not necessarily the one on disk yet.
if [ "${start_services}" -eq 1 ]; then
  config_bad=0
  for svc in "${components[@]}"; do
    [ -f "${CONFDIR}/${svc}.json" ] || continue
    if ! out="$("${PREFIX}/bin/ms-${svc}" config check --config "${CONFDIR}/${svc}.json" 2>&1)"; then
      echo "==> ${CONFDIR}/${svc}.json is not valid for ${version}:" >&2
      echo "${out}" | sed 's/^/    /' >&2
      config_bad=1
    fi
  done
  if [ "${config_bad}" -ne 0 ]; then
    cat >&2 <<'BADCONFIG'

The new application is installed and the running services have NOT been restarted, so the
installation is still up on the previous version. Fix the configuration above and run:

    systemctl restart ms-core ms-probe

Each service's previous configuration was copied to a timestamped .bak beside it, and the
version this release ships is at .json.new.
BADCONFIG
    exit 1
  fi
fi

systemctl daemon-reload

for svc in "${components[@]}"; do
  systemctl enable "ms-${svc}.service" >/dev/null
done

if [ "${start_services}" -eq 1 ]; then
  for svc in "${components[@]}"; do
    echo "==> starting ms-${svc}"
    systemctl restart "ms-${svc}.service"
  done

  # Type=notify means systemctl returns only once the service reported READY=1, so a
  # successful restart above is already the readiness check. Confirm anyway.
  sleep 1
  failed=0
  for svc in "${components[@]}"; do
    state="$(systemctl is-active "ms-${svc}.service" || true)"
    printf '    ms-%s: %s\n' "${svc}" "${state}"
    [ "${state}" = "active" ] || failed=1
  done
  [ "${failed}" -eq 0 ] || die "one or more services failed to start; see journalctl -u ms-core -u ms-probe"
fi

cat <<SUMMARY

MonitoringSystem ${version} installed.

  configuration   ${CONFDIR}/{$(IFS=,; echo "${components[*]}")}.json
  application     ${PREFIX}
  logs            journalctl -u ms-core -u ms-probe -f

Next: set the database connection in ${CONFDIR}/core.json, then
  systemctl restart ms-core
SUMMARY
