#!/usr/bin/env bash
# MonitoringSystem remote probe installer for Linux (systemd) — TASKS.md R-07.
#
# Run from inside an unpacked probe-only tarball:
#
#     sudo ./install-probe.sh --enrolment web-dc2.enrol
#     sudo ./install-probe.sh --enrolment web-dc2.enrol --name web-dc2 --no-start
#
# The bundle comes from the core host:  sudo /opt/ms/bin/ms-enrol web-dc2 --out web-dc2.enrol
#
# **This is a separate installer from `install.sh`, not a flag on it.** `install.sh --probe-only`
# already existed, and it installs from the full release tarball — so putting a probe on a remote
# host meant shipping the core, the web UI and the core's dependencies to a machine that will
# never run them, and then trusting a flag not to start them. A probe host should receive a probe.
#
# Re-running upgrades in place. Configuration under /etc/ms is never overwritten, and an
# enrolment already on disk is kept unless a new bundle is given.
set -euo pipefail

PREFIX=/opt/ms
CONFDIR=/etc/ms
enrolment=''
display_name=''
start_service=1

die() { echo "error: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enrolment|--enrollment) enrolment="$2"; shift ;;
    --name)       display_name="$2"; shift ;;
    --no-start)   start_service=0 ;;
    --prefix)     PREFIX="$2"; shift ;;
    --confdir)    CONFDIR="$2"; shift ;;
    -h|--help)    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(cat "${here}/VERSION")"

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

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

user=ms-probe

# **The enrolment is checked before anything is written.** A bundle that turns out to be
# unreadable halfway through would otherwise leave a half-installed service pointing at a CA that
# is not there, which starts, fails to connect, and reports a TLS error rather than the truth.
if [ -n "${enrolment}" ]; then
  [ -f "${enrolment}" ] || die "no such enrolment bundle: ${enrolment}"
  node -e '
    const { readFileSync } = require("node:fs");
    let bundle;
    try {
      bundle = JSON.parse(readFileSync(process.argv[1], "utf8"));
    } catch (error) {
      console.error(`the enrolment bundle is not readable JSON: ${error.message}`);
      process.exit(1);
    }
    const missing = [];
    if (bundle.bundleVersion !== 1) missing.push(`bundleVersion ${String(bundle.bundleVersion)} is not supported by this installer`);
    if (!bundle.core?.host) missing.push("core.host");
    if (!bundle.core?.port) missing.push("core.port");
    if (!bundle.accessKey) missing.push("accessKey");
    for (const field of ["ca", "cert", "key"]) {
      if (!bundle.tls?.[field]) missing.push(`tls.${field}`);
    }
    if (missing.length > 0) {
      console.error(`the enrolment bundle is incomplete: ${missing.join(", ")}`);
      process.exit(1);
    }
  ' "${enrolment}" || die "refusing to install with an unusable enrolment bundle"
elif [ ! -f "${CONFDIR}/probe.json" ]; then
  die "no enrolment bundle given and no existing ${CONFDIR}/probe.json — run 'ms-enrol <name>' on the core host and pass the result with --enrolment"
fi

echo "==> installing MonitoringSystem probe ${version} to ${PREFIX}"

# --- application ---------------------------------------------------------------------------
install -d -m 0755 "${PREFIX}"
rm -rf "${PREFIX:?}/app" "${PREFIX:?}/bin"
cp -R "${here}/app" "${PREFIX}/app"
cp -R "${here}/bin" "${PREFIX}/bin"
chmod +x "${PREFIX}"/bin/*
printf '%s\n' "${version}" > "${PREFIX}/VERSION"

install -d -m 0755 "${CONFDIR}"
# 0755: traversable by the service user. What is secret here is the private key, protected per
# file below.
install -d -m 0755 "${CONFDIR}/tls"

if ! getent passwd "${user}" >/dev/null; then
  echo "==> creating service user ${user}"
  useradd --system --no-create-home --home-dir "/var/lib/${user}" \
          --shell /usr/sbin/nologin --comment "MonitoringSystem probe" "${user}"
fi

install -d -m 0750 -o "${user}" -g "${user}" "/var/lib/${user}"
install -d -m 0750 -o "${user}" -g "${user}" "/var/lib/${user}/spool"
install -d -m 0750 -o "${user}" -g "${user}" "/var/log/${user}"

# --- enrolment -----------------------------------------------------------------------------
if [ -n "${enrolment}" ]; then
  echo "==> applying the enrolment bundle"
  # Written by node rather than by shell so the PEM bodies never pass through a variable, a
  # here-doc or a log line. umask covers the moment between create and chmod.
  ( umask 077
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const [file, confdir] = process.argv.slice(1);
      const bundle = JSON.parse(readFileSync(file, "utf8"));
      const tls = join(confdir, "tls");
      writeFileSync(join(tls, "ca.crt"), bundle.tls.ca);
      writeFileSync(join(tls, "probe.crt"), bundle.tls.cert);
      writeFileSync(join(tls, "probe.key"), bundle.tls.key);
      process.stdout.write(`${bundle.probeName ?? ""}\n`);
    ' "${enrolment}" "${CONFDIR}" > /tmp/.ms-probe-name.$$
  )
  bundle_name="$(cat /tmp/.ms-probe-name.$$)"; rm -f /tmp/.ms-probe-name.$$
  [ -n "${display_name}" ] || display_name="${bundle_name}"

  # A CA certificate is public by definition. The probe's own pair is not.
  chmod 644 "${CONFDIR}/tls/ca.crt"
  chown root:"${user}" "${CONFDIR}/tls/probe.crt" "${CONFDIR}/tls/probe.key"
  chmod 640 "${CONFDIR}/tls/probe.crt"
  chmod 640 "${CONFDIR}/tls/probe.key"
fi

# --- configuration -------------------------------------------------------------------------
if [ -f "${CONFDIR}/probe.json" ]; then
  echo "==> keeping existing ${CONFDIR}/probe.json"
  install -m 0640 -o root -g "${user}" "${here}/etc/probe.json" "${CONFDIR}/probe.json.new"
  # An upgrade that also carries a new bundle still has to point at the core the bundle names —
  # that is usually *why* a second bundle was issued — so the endpoint and the key are updated
  # in place while every tuning setting the operator changed is left alone.
  if [ -n "${enrolment}" ]; then
    echo "==> updating the core endpoint and access key from the bundle"
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      const [cfgPath, bundlePath] = process.argv.slice(1);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      cfg.core = { ...cfg.core, host: bundle.core.host, port: bundle.core.port, accessKey: bundle.accessKey };
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    ' "${CONFDIR}/probe.json" "${enrolment}"
  fi
else
  echo "==> installing ${CONFDIR}/probe.json"
  install -m 0640 -o root -g "${user}" "${here}/etc/probe.json" "${CONFDIR}/probe.json"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [cfgPath, bundlePath, name] = process.argv.slice(1);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    cfg.core = { ...cfg.core, host: bundle.core.host, port: bundle.core.port, accessKey: bundle.accessKey };
    // The name an operator will see in the approval queue. "Local probe" from the shipped
    // example would put every enrolled machine in that queue under the same name, which is the
    // one moment a name has to be right.
    if (name) cfg.probe = { ...cfg.probe, displayName: name };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  ' "${CONFDIR}/probe.json" "${enrolment}" "${display_name}"
fi

install -m 0644 "${here}/deploy/systemd/ms-probe.service" "/etc/systemd/system/ms-probe.service"
systemctl daemon-reload
systemctl enable ms-probe.service >/dev/null

core_host="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).core.host' "${CONFDIR}/probe.json")"

if [ "${start_service}" -eq 1 ]; then
  echo "==> starting ms-probe"
  systemctl restart ms-probe.service
  # Type=notify: systemctl returns once the service reported READY=1. Confirm anyway.
  sleep 1
  state="$(systemctl is-active ms-probe.service || true)"
  printf '    ms-probe: %s\n' "${state}"
  [ "${state}" = "active" ] || die "ms-probe failed to start; see journalctl -u ms-probe"
fi

cat <<SUMMARY

MonitoringSystem probe ${version} installed.

  configuration   ${CONFDIR}/probe.json
  application     ${PREFIX}
  logs            journalctl -u ms-probe -f

This probe is connecting to ${core_host} and will wait there: a probe that has
reached the core is not yet a probe that may scan. Approve it by name on the
core's probes page, and delete the enrolment bundle from both machines.
SUMMARY
