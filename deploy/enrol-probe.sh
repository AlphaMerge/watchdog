#!/usr/bin/env bash
# Issue an enrolment bundle for one remote probe (TASKS.md R-07).
#
# Run on the *core* host, which is where the probe-channel CA lives:
#
#     sudo /opt/ms/bin/ms-enrol web-dc2 --host "$(hostname -f)" --out web-dc2.enrol
#     sudo /opt/ms/bin/ms-enrol web-dc2 --host "$(hostname -f)" | ssh web-dc2 'umask 077; cat > web-dc2.enrol'
#
# Carry the file to the probe host and hand it to that host's installer:
#
#     sudo ./install-probe.sh --enrolment web-dc2.enrol
#
# **Every probe gets its own certificate, and that is the point of this script.** Before it,
# `install.sh` issued exactly one `probe.crt`/`probe.key` on the core host and any remote probe
# had to be given a copy — so every probe in the installation presented the same TLS identity,
# and revoking one at the transport layer was not possible at all. `R-01` made the *access key*
# per-probe and revocable; this does the same for the certificate underneath it.
#
# **The bundle is a secret and it is short-lived by intent.** It carries a private key and the
# enrolment key, so it is written 0600, it is meant to be carried once and deleted, and the probe
# it enrols still has to be approved by a person before it is given a single sensor to scan
# (`R-01`). A leaked bundle is therefore an identity that can knock, not an identity that
# monitors — but it is still a private key, so treat it like one.
#
# **The key is generated here rather than on the probe.** A probe generating its own key and
# sending a CSR would be better — the private key would never travel — but submitting a CSR
# needs a trusted channel to the core, which is the very channel being established. The approval
# queue is what makes carrying the key acceptable: nothing the bundle grants takes effect until
# somebody approves the probe by name.
set -euo pipefail

CONFDIR=/etc/ms
out=''
core_host=''
core_port=''
days=825

die() { echo "error: $*" >&2; exit 1; }

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

name=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)      out="$2"; shift ;;
    --confdir)  CONFDIR="$2"; shift ;;
    --host)     core_host="$2"; shift ;;
    --port)     core_port="$2"; shift ;;
    --days)     days="$2"; shift ;;
    -h|--help)  usage ;;
    -*)         die "unknown option: $1" ;;
    *)
      [ -z "${name}" ] || die "give one probe name (got '${name}' and '$1')"
      name="$1"
      ;;
  esac
  shift
done

[ -n "${name}" ] || die "usage: ms-enrol <probe-name> [--out FILE] [--host H] [--port P]"

# The name becomes a certificate CN and a filename. Refuse anything that would need quoting or
# could climb out of a directory — this runs as root and the name comes from a command line, but
# an operator pasting from a spreadsheet is the ordinary case and a clear refusal beats a
# confusing openssl error.
case "${name}" in
  *[!A-Za-z0-9._-]*) die "probe name may contain only letters, digits, dot, underscore and dash (got '${name}')" ;;
  ''|.|..) die "'${name}' is not a usable probe name" ;;
esac
[ "${#name}" -le 64 ] || die "probe name is longer than 64 characters"

[ "$(id -u)" -eq 0 ] || die "must run as root: the CA key is readable only by root"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

[ -f "${CONFDIR}/tls/ca.crt" ] || die "no CA at ${CONFDIR}/tls/ca.crt — is this the core host?"
[ -f "${CONFDIR}/tls/ca.key" ] || die "no CA key at ${CONFDIR}/tls/ca.key — is this the core host?"
[ -f "${CONFDIR}/access-key" ] || die "no enrolment key at ${CONFDIR}/access-key"

# Where the probe should dial. Read from the core's own configuration so the bundle does not
# describe an endpoint the core is not listening on; the flags exist for the case the operator
# knows better — a NAT, a load balancer, a name the probe resolves differently.
if [ -z "${core_host}" ] || [ -z "${core_port}" ]; then
  if [ -f "${CONFDIR}/core.json" ] && command -v node >/dev/null 2>&1; then
    # **One value per line, and read them by position.** Space-separated on one line looks
    # tidier and is wrong: the host is *deliberately* empty when the core binds a wildcard, and
    # `read host port` given " 23560" skips the leading whitespace and puts the port in `host`,
    # leaving the port empty — which reports "could not work out the core's port" for a
    # configuration that states it plainly.
    cfg="$(node -e '
      const { readFileSync } = require("node:fs");
      const cfg = JSON.parse(readFileSync(process.argv[1], "utf8"));
      const ep = cfg.probeEndpoint ?? {};
      // 0.0.0.0 is what the core binds, never what a probe dials. Reporting it would produce a
      // bundle that cannot possibly connect, so say nothing and let the operator supply it.
      const host = ep.host === "0.0.0.0" || ep.host === "::" ? "" : (ep.host ?? "");
      process.stdout.write(`${host}\n${String(ep.port ?? "")}\n`);
    ' "${CONFDIR}/core.json")"
    cfg_host="$(printf '%s\n' "${cfg}" | sed -n 1p)"
    cfg_port="$(printf '%s\n' "${cfg}" | sed -n 2p)"
    [ -n "${core_host}" ] || core_host="${cfg_host}"
    [ -n "${core_port}" ] || core_port="${cfg_port}"
  fi
fi
[ -n "${core_host}" ] || die "could not work out the core's address — pass --host (the core binds a wildcard address, which a probe cannot dial)"
[ -n "${core_port}" ] || die "could not work out the core's port — pass --port"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
chmod 700 "${work}"

(
  umask 077
  cd "${work}"

  # clientAuth only: a probe never serves. No SAN, because nothing dials the probe by name —
  # the core matches the CA and the application layer matches the access key.
  cat > probe.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EXT

  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout probe.key -out probe.csr \
    -subj "/CN=${name}/OU=probe/O=MonitoringSystem" 2>/dev/null

  # A random serial rather than -CAcreateserial: the .srl file lives beside the CA key and two
  # operators enrolling at once would otherwise race for it and could issue a duplicate serial,
  # which is exactly the thing a serial exists to prevent.
  openssl x509 -req -in probe.csr \
    -CA "${CONFDIR}/tls/ca.crt" -CAkey "${CONFDIR}/tls/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -out probe.crt -days "${days}" -sha256 -extfile probe.ext 2>/dev/null

  rm -f probe.csr probe.ext
)

# **The certificate this probe will be bound to** (`P-326`). The core records the fingerprint of the
# certificate a probe enrols with and refuses any other under that identity, so the operator can
# check it against what the approval page shows — and, when re-issuing one for an existing probe,
# set it first with PUT /api/v1/probes/<gid>/certificate.
fingerprint="$(openssl x509 -noout -fingerprint -sha256 -in "${work}/probe.crt" | sed 's/^[^=]*=//')"

# One self-describing file rather than a tarball of loose secrets: it can be scp'd, pasted into
# a configuration-management tool, or read by the Windows installer, which has no tar.
bundle="$(
  node -e '
    const { readFileSync } = require("node:fs");
    const [work, confdir, name, host, port] = process.argv.slice(1);
    const read = (p) => readFileSync(p, "utf8");
    process.stdout.write(
      JSON.stringify(
        {
          bundleVersion: 1,
          probeName: name,
          issuedAt: new Date().toISOString(),
          core: { host, port: Number(port) },
          // The shared enrolment key. R-01 replaces it with a key issued to this probe alone at
          // the first handshake after approval, after which this value no longer opens anything
          // for it.
          accessKey: read(`${confdir}/access-key`).trim(),
          tls: {
            ca: read(`${confdir}/tls/ca.crt`),
            cert: read(`${work}/probe.crt`),
            key: read(`${work}/probe.key`),
          },
        },
        null,
        2,
      ) + "\n",
    );
  ' "${work}" "${CONFDIR}" "${name}" "${core_host}" "${core_port}"
)"

if [ -n "${out}" ]; then
  # **A new file every time, and 0600 whatever was there** (`H-21`). `umask` decides a file's mode
  # only when the file is created, so `--out` onto a bundle left from an earlier run kept that
  # file's mode — whatever it had been given since. Written beside the target and renamed over it,
  # the bundle is always a fresh inode that `mktemp` created 0600.
  tmp="$(mktemp "${out}.XXXXXX")" || die "cannot write beside ${out}"
  trap 'rm -rf "${work}" "${tmp}"' EXIT
  printf '%s\n' "${bundle}" > "${tmp}"
  mv -f "${tmp}" "${out}"
  cat >&2 <<SUMMARY
==> enrolment bundle for '${name}' written to ${out}

  It contains a private key and the enrolment key. Copy it to the probe host, run

      sudo ./install-probe.sh --enrolment $(basename "${out}")

  and delete it from both machines afterwards. The probe will connect and wait.
  On this host, an administrator finds its gid in GET /api/v1/probes?status=pending
  under the name '${name}', creates a probe object for it, and approves it onto
  that object, with no "local" (docs/installation.md, Remote probes):

      POST /api/v1/probes/<gid>/approve   {"objectId":<id>}

  Its certificate's SHA-256 fingerprint, which the core binds it to:

      ${fingerprint}
SUMMARY
else
  # No --out: straight to stdout, for `ms-enrol name | ssh host 'cat > b.enrol'`. The warning
  # goes to stderr so it does not end up inside the bundle.
  #
  # **`sudo ms-enrol name > file` is the operator's shell creating the file** (`H-21`), before
  # sudo runs and with that shell's umask — 0644 as often as not, which put a private key and the
  # enrolment key where every account on the core host could read them. A regular file on stdout
  # is made 0600 before a byte of the bundle is written to it, or refused.
  if [ -f "/proc/$$/fd/1" ]; then
    chmod 600 "/proc/$$/fd/1" 2>/dev/null \
      || die "standard output is a file this cannot make private; use --out FILE instead"
  fi
  printf '%s\n' "${bundle}"
  echo "==> enrolment bundle for '${name}' written to stdout (it contains a private key)" >&2
  echo "==> certificate SHA-256 fingerprint: ${fingerprint}" >&2
fi
