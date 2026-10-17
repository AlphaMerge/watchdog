# shellcheck shell=sh
# The sysctl drop-in ms-setup wrote for the probe's ping (`H-31`'s fix), taken away with the
# package (`H-34`). Not a script of its own: `scripts/package-deb.sh` puts this text into the
# .deb's postrm, under `purge`, and `scripts/package-rpm.sh` into the .rpm's postun scriptlet,
# under an erase ($1 = 0) — the package's files, ms-setup among them, are gone by the time either
# runs, so this has to travel inside them. A tarball installation's `ms-uninstall` reads it from
# beside itself before it removes the release, and runs it after (`H-39`), in the same place in
# the order. POSIX sh, because dpkg runs a postrm with /bin/sh,
# dash on Debian, and under `set -e`: **nothing here may change the scriptlet's exit status**, so
# every command that can fail is a condition. A postrm that failed would leave the package
# half-purged, in `rc`, over a file. No percent sign anywhere: rpm would read one as a macro
# (`deploy-scripts.test.ts` checks).
#
# **Removed only while it is still ms-setup's, byte for byte.** It is a file under /etc that an
# operator may have edited — widened to another group, or kept for something else that pings — and
# one that has changed is left where it is, with a line saying so. Recognised by its content
# rather than by a marker, so the files the release candidates wrote, which carry none, are
# recognised too: the text below is what setup.sh has written since `H-31`, with the group id
# read back out of the file, since the id is the one thing in it that differs between hosts. If
# setup.sh ever writes something else, the old text has to stay recognised here as well.
#
# **And never while a probe is still installed.** `ms` and `ms-probe` ship the same tree under
# /opt/ms and conflict, so a host that switched from one to the other has the other's probe, and
# it needs this file. Whether one is there is read from the disk, from the one file both ship and
# nothing else does, because at this point in each package manager's order that file is there only
# if the other package (or a tarball installation) is:
#   - dpkg runs `postrm purge` after the package's own files are gone — in the same `dpkg -P`, or
#     long before, when it was removed and left in `rc` — and the two declare no `Replaces`, so
#     their shared paths never belong to both. If apt purges `ms` in the same run that installs
#     `ms-probe`, the conflict removes `ms` before `ms-probe` is unpacked: the file goes, and
#     `ms-probe`'s own ms-setup then finds the range at its group alone and writes it again.
#   - rpm installs a transaction's new packages before it erases the old ones (`dnf swap ms
#     ms-probe`), and a path another installed package owns is not erased, so `ms`'s erase finds
#     `ms-probe`'s file in place. A plain `rpm -e` runs this after its own files are gone.
#
# **A plain `apt remove` keeps it**, as dpkg keeps a conffile until purge: a remove is the step
# before a reinstall as often as it is the end. rpm has no such step; an erase is the end.
#
# **The live setting is not touched.** net.ipv4.ping_group_range in the running kernel has no
# owner that can be read back: since ms-setup set it, another package's sysctl.d file, an
# operator's `sysctl -w` or a container runtime may have set it again, and the drop-in is the only
# part of the change this can tell is still ms-setup's. What it held before is not recorded
# either, so putting `1 0` back would be guessing — and a guess that closes ICMP sockets on a
# running host, for whatever has since come to use them, as a side effect of removing a package.
# Left alone, it names only the ms-probe group, which a removal leaves in place with its user and
# which nothing runs as once the probe is gone; the next boot reads sysctl.d without the file. A
# reinstall before that boot finds the range at the group alone and writes the file again.
ms_ping_conf="${MS_SETUP_SYSCTL_DIR:-/etc/sysctl.d}/60-ms-probe-ping.conf"
ms_ping_setup=/opt/ms/libexec/ms-setup
if [ -e "${ms_ping_conf}" ] || [ -L "${ms_ping_conf}" ]; then
  ms_ping_gid="$(sed -n 's/^net\.ipv4\.ping_group_range = \([0-9][0-9]*\) \1$/\1/p' "${ms_ping_conf}" 2>/dev/null || true)"
  ms_ping_written="# Written by ms-setup (MonitoringSystem). Lets the ms-probe group, and only it, open the
# unprivileged ICMP sockets its ping sensors use; ms-probe.service gives the probe no
# CAP_NET_RAW. See \"Before you start\" in /opt/ms/docs/installation.md.
net.ipv4.ping_group_range = ${ms_ping_gid} ${ms_ping_gid}"
  if [ -x "${ms_ping_setup}" ]; then
    echo "note: ${ms_ping_conf} was left in place: ${ms_ping_setup} is still installed" >&2
    echo "      (ms or ms-probe), and the probe it runs needs the file." >&2
  elif [ -f "${ms_ping_conf}" ] && [ ! -L "${ms_ping_conf}" ] && [ -n "${ms_ping_gid}" ] \
    && [ "$(cat "${ms_ping_conf}")" = "${ms_ping_written}" ]; then
    if rm -f "${ms_ping_conf}"; then
      echo "note: removed ${ms_ping_conf}, which ms-setup wrote; the running kernel's" >&2
      echo "      net.ipv4.ping_group_range is left as it is until the next boot." >&2
    else
      echo "note: could not remove ${ms_ping_conf}, which ms-setup wrote; remove it" >&2
      echo "      yourself, or the next boot opens ICMP sockets to the group it names again." >&2
    fi
  else
    echo "note: ${ms_ping_conf} is not as ms-setup wrote it, so it was left in place." >&2
    echo "      Remove it if nothing else needs ICMP sockets for the groups it names." >&2
  fi
fi
