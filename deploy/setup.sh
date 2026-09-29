#!/usr/bin/env bash
# Everything an installation needs after its files are on disk (TASKS.md H-05).
#
#     ms-setup [--components core,probe] [--confdir /etc/ms] [--prefix /opt/ms]
#              [--examples DIR] [--units DIR] [--no-start]
#              [--enrolment FILE [--name NAME]]      # a remote probe (install-probe.sh)
#
# **Three installers, one setup.** The tarball's `install.sh`, the `.deb`'s `postinst` and the
# `.rpm`'s `%post` all place files differently — one copies them, two have a package manager do
# it — and then all three need the identical remaining work: the service users, the probe-channel
# PKI, the access key, the configuration that must survive an upgrade, and the `config check`
# that must run before anything restarts. Written once here because the alternative is three
# copies that drift, and the one that drifts is the one nobody tests.
#
# Idempotent by construction, because every one of those installers re-runs it on upgrade: the CA
# is issued only if absent, the users created only if missing, and an existing configuration file
# is never overwritten. `install-probe.sh` runs it too, with the enrolment bundle it was given.
#
# **The units are the release's, and an operator never edits them** (`H-21`). They go to
# /usr/lib/systemd/system, where an upgrade replaces them, and everything an operator changes goes
# in a drop-in — `systemctl edit ms-core` — which no upgrade touches. They used to be copied into
# /etc/systemd/system on every run, over whatever the operator had done to them there, and the
# unit's own comments asked for exactly that: an upgrade put the database password credential
# back to commented out and the core came up with no password. A unit an earlier release left in
# /etc is removed when it is exactly as that release shipped it, and kept and named when it is not.
set -euo pipefail

CONFDIR=/etc/ms
PREFIX=/opt/ms
EXAMPLES=''
UNITS=''
components=()
start_services=1
enrolment=''
display_name=''
# Where the units go, and where releases before H-21 put them. The variables exist for
# `deploy-scripts.test.ts`, which runs this in a throwaway container; nothing else sets them.
UNIT_DIR="${MS_SETUP_UNIT_DIR:-/usr/lib/systemd/system}"
LEGACY_UNIT_DIR="${MS_SETUP_LEGACY_UNIT_DIR:-/etc/systemd/system}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --components) IFS=',' read -r -a components <<< "$2"; shift ;;
    --confdir)    CONFDIR="$2"; shift ;;
    --prefix)     PREFIX="$2"; shift ;;
    --examples)   EXAMPLES="$2"; shift ;;
    --units)      UNITS="$2"; shift ;;
    --no-start)   start_services=0 ;;
    --enrolment)  enrolment="$2"; shift ;;
    --name)       display_name="$2"; shift ;;
    -h|--help)    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# **Staging a machine that has nothing to connect to yet.** Baking a golden image, or laying the
# package down before the database exists, is a real thing to want — and the package managers
# give a `postinst` no way to pass a flag, so the switch has to be an environment variable. It is
# the same code path as `--no-start`, which the tarball installer already offers.
[ "${MS_SETUP_NO_START:-0}" = "1" ] && start_services=0

# **rpm runs a scriptlet with a minimal PATH, and Node is normally not on it.** rpm gives
# `%post` `/sbin:/bin:/usr/sbin:/usr/bin` and nothing more, while dpkg follows Debian policy and
# includes `/usr/local/*` — so the identical setup script found Node under dpkg and failed under
# rpm. That is not a packaging curiosity: no enterprise distribution ships a Node this new, so
# the one an operator installs comes from the official tarball, and the official tarball goes to
# `/usr/local`. Refusing to install there would be refusing the normal case.
case ":${PATH}:" in
  *:/usr/local/bin:*) ;;
  *) PATH="/usr/local/sbin:/usr/local/bin:${PATH}" ;;
esac
export PATH

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)"
command -v node >/dev/null 2>&1 || die "Node.js is required on PATH"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

# Defaults that depend on --prefix, so they are resolved after the parse rather than beside it.
[ -n "${EXAMPLES}" ] || EXAMPLES="${PREFIX}/etc"
[ -n "${UNITS}" ] || UNITS="${PREFIX}/deploy/systemd"

# **Which services this installation has is a fact on disk, not an assumption.** A probe-only
# package installs one launcher, the full package two — so detecting them means the probe host
# never has a core set up for it by a flag somebody forgot to pass.
if [ "${#components[@]}" -eq 0 ]; then
  for svc in core probe; do
    [ -x "${PREFIX}/bin/ms-${svc}" ] && components+=("${svc}")
  done
fi
[ "${#components[@]}" -gt 0 ] || die "no ms-core or ms-probe launcher under ${PREFIX}/bin"
version="$(cat "${PREFIX}/VERSION" 2>/dev/null || echo unknown)"

has_component() {
  case " ${components[*]} " in *" $1 "*) return 0 ;; esac
  return 1
}

install -d -m 0755 "${CONFDIR}"
# 0755: the directory must be traversable by every service user. What is secret here are the
# private keys, and they are protected per file below.
install -d -m 0755 "${CONFDIR}/tls"

# --- a remote probe's enrolment (R-07) -----------------------------------------------------
#
# The bundle `ms-enrol` issued on the core host: its CA, this probe's own key pair, the core's
# address and the enrolment key. `install-probe.sh` has already refused one that is incomplete.
# Written by node rather than by shell so the PEM bodies never pass through a variable, a here-doc
# or a log line; umask covers the moment between create and chmod. It lands before the PKI step
# below, which therefore finds a CA and issues nothing.
bundle_name=''
if [ -n "${enrolment}" ]; then
  has_component probe || die "--enrolment is for a probe"
  echo "==> applying the enrolment bundle"
  bundle_name="$(
    umask 077
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
    ' "${enrolment}" "${CONFDIR}"
  )"
  [ -n "${display_name}" ] || display_name="${bundle_name}"
  # A CA certificate is public by definition. The probe's own pair is handled with the service
  # user below.
  chmod 644 "${CONFDIR}/tls/ca.crt"
fi

# --- probe-channel PKI ---------------------------------------------------------------------
# The core and its probes speak mutual TLS (WORKFLOW.MD §10), so a working install needs a CA
# and a key pair for each side. We issue them here rather than making the operator do it: an
# install that will not start until you have read an OpenSSL manual is not an install.
# Replace these with your own PKI if you have one; per-probe enrolment is `R-07`'s `ms-enrol`.
if [ ! -f "${CONFDIR}/tls/ca.crt" ]; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required (used to issue the probe-channel certificates)"
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
# once; remote probes are given it at enrolment. Only a core, or a probe configured from nothing on
# the core's own host, has a use for it: a remote probe's comes in its bundle, and minting one on
# a probe host would be a key to nothing, left lying about.
access_key=''
if has_component core || { [ -z "${enrolment}" ] && [ ! -f "${CONFDIR}/probe.json" ]; }; then
  if [ ! -f "${CONFDIR}/access-key" ]; then
    command -v openssl >/dev/null 2>&1 || die "openssl is required (used to generate the access key)"
    ( umask 077; openssl rand -hex 32 > "${CONFDIR}/access-key" )
  fi
  access_key="$(cat "${CONFDIR}/access-key")"
fi

# sha256 of every ms-core.service and ms-probe.service a release installed into
# /etc/systemd/system, from `git log -- deploy/systemd` — P-227, P-222, P-215, P-213 and the first
# import, for each. The list is closed: nothing writes a unit there any more.
LEGACY_STOCK_UNITS='
2b7cf8ef37360883a9f418d5afd3a750d40c5c3fcab402cdece668dbc815f01d
52654ac0f1e561328c9bc67ca67b20375c6bf411a287916ffd7f3343dff3f355
1d756d85390479368d323f00c29779250e3accbf5956d178bef2dcd20c3fb277
11ddd1fd77034248d2fdd34cb3a31c1fe2e4c9344cdfd0943c37f49b57549c66
a98929b55f3d86581ecf123bf540500ab2ec0317d78de313e683310b9c894fec
55c2ddff98e00709777c07c4e49f2f788a01617e7c731d0ceda7b2f6cd570244
de3ec0310afa27c15d1800f1f2a2744e8d8ee452342fb8d6762c2e91b4eee679
1239c0d05c4d9e146c577107b07ddeed6e2fb66dd8d550478efd60ce987d806a
f3dd9c699bc5268b6cdbded54f051447336e45b3337c79141028232c825becbd
0265d1be8e92eff9a22b7ee710d7b13f7936f453a5b6749cb991a3ba9af4cb3d
'

# The release's unit into /usr/lib, and an earlier release's out of /etc — unless somebody edited
# it, in which case it stays exactly as it is and is named at the end. A unit in /etc overrides
# the one in /usr/lib whole, so a kept one means this release's unit changes do not apply; that
# is a fact to put in front of the operator, not a reason to throw their change away.
kept_units=()
place_unit() {
  local svc="$1"
  local vendor="${UNIT_DIR}/ms-${svc}.service"
  local legacy="${LEGACY_UNIT_DIR}/ms-${svc}.service"
  install -d -m 0755 "${UNIT_DIR}"
  # The packages ship the unit themselves; for them this finds it identical and leaves it.
  cmp -s "${UNITS}/ms-${svc}.service" "${vendor}" 2>/dev/null \
    || install -m 0644 "${UNITS}/ms-${svc}.service" "${vendor}"
  [ -f "${legacy}" ] && [ ! -L "${legacy}" ] || return 0
  local sum
  sum="$(sha256sum "${legacy}" | cut -d' ' -f1)"
  # Only a whole hash is compared: an empty one would match the list, and remove an edited unit.
  if [ "${#sum}" -eq 64 ] && case "${LEGACY_STOCK_UNITS}" in *"${sum}"*) true ;; *) false ;; esac; then
    # Disabled first: the enable link points at this file, and `enable` below re-points it.
    systemctl disable "ms-${svc}.service" >/dev/null 2>&1 || true
    rm -f "${legacy}"
    echo "==> ms-${svc}.service now lives in ${UNIT_DIR}; changes go in 'systemctl edit ms-${svc}'"
  else
    kept_units+=("${svc}")
  fi
}

# The unit both services name in OnFailure= (`H-23`), which starts one the start limit stopped for
# crashing again after a cool-down. One template, whichever services this host runs.
install -d -m 0755 "${UNIT_DIR}"
cmp -s "${UNITS}/ms-recover@.service" "${UNIT_DIR}/ms-recover@.service" 2>/dev/null \
  || install -m 0644 "${UNITS}/ms-recover@.service" "${UNIT_DIR}/ms-recover@.service"

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
    # A timestamped copy before anything else touches this directory (H-03) — and before the one
    # edit made here, a new enrolment's endpoint, so that the copy is the operator's file as they
    # left it. It is the copy an operator wants when *their* edit, made to satisfy the new build,
    # turns out to be the thing that broke it. Owned by root and mode 0600: a configuration file
    # holds the database password.
    backup="${CONFDIR}/${svc}.json.$(date -u +%Y%m%dT%H%M%SZ).bak"
    install -m 0600 -o root -g root "${CONFDIR}/${svc}.json" "${backup}"
    echo "    backed up to ${backup}"
    install -m 0640 -o root -g "${user}" "${EXAMPLES}/${svc}.json" "${CONFDIR}/${svc}.json.new"
    # An upgrade that also carries a new bundle still has to point at the core the bundle names —
    # that is usually *why* a second bundle was issued — so the endpoint and the key are updated
    # in place while every tuning setting the operator changed is left alone.
    if [ "${svc}" = probe ] && [ -n "${enrolment}" ]; then
      echo "    updating the core endpoint and access key from the bundle"
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
    echo "==> installing ${CONFDIR}/${svc}.json"
    install -m 0640 -o root -g "${user}" "${EXAMPLES}/${svc}.json" "${CONFDIR}/${svc}.json"
    if [ "${svc}" = probe ] && [ -n "${enrolment}" ]; then
      # A remote probe: the core, the key and the name all come from the bundle. The name is the
      # one an operator will see in the approval queue — "Local probe" from the shipped example
      # would put every enrolled machine there under the same name, at the one moment a name has
      # to be right.
      node -e '
        const { readFileSync, writeFileSync } = require("node:fs");
        const [cfgPath, bundlePath, name] = process.argv.slice(1);
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
        cfg.core = { ...cfg.core, host: bundle.core.host, port: bundle.core.port, accessKey: bundle.accessKey };
        if (name) cfg.probe = { ...cfg.probe, displayName: name };
        writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
      ' "${CONFDIR}/probe.json" "${enrolment}" "${display_name}"
    else
      # Wire the generated access key into a freshly installed configuration. A core also gets
      # this machine's own name in api.allowedHosts (`A-47`): the core answers only to its
      # addresses, localhost and the names it is given, and the name an operator types first is
      # the one the machine calls itself. Anything that is not a plain name is left out rather
      # than written somewhere the core would refuse to start over it.
      node -e '
        const { readFileSync, writeFileSync } = require("node:fs");
        const { isIP } = require("node:net");
        const [path, key, svc, host] = process.argv.slice(1);
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        if (svc === "core") {
          cfg.probeEndpoint.accessKeys = [key];
          const name = (host || "").trim().toLowerCase().replace(/\.$/, "");
          const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
          const plain = new RegExp(`^${label}(?:\\.${label})*$`).test(name);
          if (plain && isIP(name) === 0 && name !== "localhost" && !name.endsWith(".localhost")) {
            cfg.api.allowedHosts = [name];
          }
        } else cfg.core.accessKey = key;
        writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
      ' "${CONFDIR}/${svc}.json" "${access_key}" "${svc}" "$(hostname -f 2>/dev/null || hostname)"
    fi
  fi

  place_unit "${svc}"
done

# **Loaded before anything can refuse** (`H-21`). The check below exits without starting anything,
# and what the operator does next is `systemctl start`; that has to start this release's units. A
# refusal used to exit first, with the new files on disk and systemd still holding the old
# definitions — so the documented recovery ran the new build under the old unit, P-213's throttle
# and no start limit included, until some later reload.
systemctl daemon-reload
for svc in "${components[@]}"; do
  systemctl enable "ms-${svc}.service" >/dev/null
done

for svc in ${kept_units[@]+"${kept_units[@]}"}; do
  cat >&2 <<KEPT
==> ${LEGACY_UNIT_DIR}/ms-${svc}.service was edited, so it was kept as it is.
    It overrides ${UNIT_DIR}/ms-${svc}.service whole, so nothing this release changes in the
    unit applies while it is there. Move your change into a drop-in and remove it:

        diff ${UNIT_DIR}/ms-${svc}.service ${LEGACY_UNIT_DIR}/ms-${svc}.service
        systemctl edit ms-${svc}        # only the lines you changed, under [Service]
        rm ${LEGACY_UNIT_DIR}/ms-${svc}.service
        systemctl daemon-reload && systemctl restart ms-${svc}
KEPT
done

# **A RestartSec below a second turns ms-recover off** (`H-23`). It tells a crash loop the start
# limit stopped from a stop or a refusal by how long the unit waited between its process exiting
# and failing: RestartSec for the one, under a millisecond for the others. Read from systemd, raw,
# so an operator's drop-in counts; unreadable is not a finding.
for svc in "${components[@]}"; do
  restart_usec="$(busctl get-property org.freedesktop.systemd1 \
    "/org/freedesktop/systemd1/unit/ms_2d${svc}_2eservice" \
    org.freedesktop.systemd1.Service RestartUSec 2>/dev/null || true)"
  restart_usec="${restart_usec#t }"
  case "${restart_usec}" in '' | *[!0-9]*) continue ;; esac
  if [ "${restart_usec}" -lt 1000000 ]; then
    cat >&2 <<SHORT
==> warning: ms-${svc}.service waits less than a second before a restart (RestartSec, in a drop-in?).
    At that, ms-recover cannot tell a crash loop from a stop, so if the start limit stops
    ms-${svc} for crashing, nothing starts it again. See "When a service keeps crashing" in
    docs/administration.md.
SHORT
  fi
done

# --- will the configuration this installation already has load under the new build? ---------
#
# **Asked before anything is started**, so that a setting that was renamed or made required is
# something an operator reads here rather than in `journalctl` afterwards (`H-03`). The tarball
# installers have already asked the new build the same question, before they stopped or replaced
# anything (`place-release.sh`), which is when the answer can still leave the old version running;
# this is the same question for the packages, which cannot ask before they unpack, and for a
# re-run by hand. A `.json.new` sits beside each file for the diff.
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
    # **What is true, and nothing else** (`H-21`). This said "still up on the previous version",
    # which was never so: the files had already been replaced, and a service still running was an
    # old process on a new tree that its next restart — a watchdog kill, a reboot — would bring
    # up as the new build on this refused configuration. The tarball installers now ask the new
    # build before they stop or replace anything, so they seldom reach here; a package stops the
    # services before it unpacks, so for a package they are stopped.
    {
      echo
      echo "The configuration above does not load under ${version}, so nothing was started or"
      echo "restarted. The application in ${PREFIX} is already ${version}. Where each service stands:"
      echo
      for svc in "${components[@]}"; do
        printf '    ms-%-7s %s\n' "${svc}" "$(systemctl is-active "ms-${svc}.service" 2>/dev/null || true)"
      done
      echo
      echo "Fix the configuration, then start them:"
      echo
      echo "    systemctl reset-failed $(printf 'ms-%s ' "${components[@]}")"
      echo "    systemctl start $(printf 'ms-%s ' "${components[@]}")"
      echo
      echo "(or, after a .deb, 'dpkg --configure -a', which runs this again). Each service's"
      echo "previous configuration was copied to a timestamped .bak beside it, and the version this"
      echo "release ships is at .json.new."
    } >&2
    exit 1
  fi
fi

if [ "${start_services}" -eq 1 ]; then
  # Every service is attempted, whatever happens to the first: under `set -e` a core that failed
  # its restart — a migration, a database not there — used to end the script there and leave the
  # probe on whatever it was running before.
  failed=0
  for svc in "${components[@]}"; do
    echo "==> starting ms-${svc}"
    # A unit left `failed` by the start limit refuses even a deliberate start until this (P-215).
    systemctl reset-failed "ms-${svc}.service" >/dev/null 2>&1 || true
    systemctl restart "ms-${svc}.service" || failed=1
  done

  # Type=notify means systemctl returns only once the service reported READY=1, so a
  # successful restart above is already the readiness check. Confirm anyway.
  sleep 1
  for svc in "${components[@]}"; do
    state="$(systemctl is-active "ms-${svc}.service" || true)"
    printf '    ms-%s: %s\n' "${svc}" "${state}"
    [ "${state}" = "active" ] || failed=1
  done
  [ "${failed}" -eq 0 ] || die "one or more services failed to start; see journalctl -u ms-core -u ms-probe"
fi
