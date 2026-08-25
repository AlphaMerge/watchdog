#!/bin/sh
# Start the three daemons. No systemd in a container, and this box is small enough that a
# supervisor would be more moving parts than the thing it supervises.
set -eu

# A login for the SSH sensors in Phase 6. Development only: the credentials come from the
# environment, default to something obviously not a secret, and this box is bound to loopback.
user="${TARGET_SSH_USER:-monitor}"
pass="${TARGET_SSH_PASSWORD:-monitor}"
if ! id "${user}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${user}"
fi
echo "${user}:${pass}" | chpasswd

mkdir -p /run/sshd
/usr/sbin/sshd

# -C is not optional. Passing -c without it makes snmpd read the file *twice* — once from its
# default search path and once because we named it — so it binds udp:161, tries to bind it a
# second time, and exits with "Error opening specified endpoint".
#
# MIBS='' keeps the agent from parsing the MIB text files the `snmp` package ships. It needs none
# of them to answer, and without snmp-mibs-downloader (non-free) they emit screens of warnings.
MIBS='' snmpd -Lo -f -C -c /etc/snmp/snmpd.conf &
snmpd_pid=$!

# A dead snmpd used to leave the box up and answering on three of four ports, which reads as
# healthy right up until an SNMP sensor comes back Down for no visible reason.
sleep 2
if ! kill -0 "${snmpd_pid}" 2>/dev/null; then
  echo "ms-target: snmpd failed to start; refusing to come up half-monitored" >&2
  exit 1
fi

echo "ms-target up: ssh=22 http=80 snmp=161/udp icmp=yes"
exec nginx -g 'daemon off;'
