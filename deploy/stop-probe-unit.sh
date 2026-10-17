# shellcheck shell=sh
# The probe's unit, stopped and disabled when the package that ran it is erased (`H-40`), unless
# another installation's probe runs from it now. Not a script of its own: `scripts/package-rpm.sh`
# puts this text into the postun scriptlet of `ms` and of `ms-probe`, under an erase ($1 = 0).
# POSIX sh, nothing in it may change the scriptlet's exit status, and no percent sign anywhere,
# for the reasons `remove-ping-conf.sh` gives.
#
# **In postun, because preun cannot tell.** `ms` and `ms-probe` ship the same tree under /opt/ms
# and the same ms-probe.service, and conflict. `dnf swap ms ms-probe` installs `ms-probe` first —
# its post scriptlet sets up and starts the probe — and only then erases `ms`, whose preun used to
# stop and disable ms-probe.service there and then: the swap ended with the new package's probe
# stopped, disabled and saying nothing. In preun both packages' files are on disk whichever case
# it is. Once an erase has removed its own files, a path both packages ship is there only if the
# other package (or a tarball installation) is, which is how `remove-ping-conf.sh` reads it too.
# So this asks after the files have gone, and a plain erase leaves the probe running over its
# departing files for the second or two that takes. The core, which `ms-probe` does not ship, is
# still stopped in preun.
#
# **The .deb keeps stopping it in its prerm**, and needs nothing else: apt removes a conflicting
# package before it unpacks the one that replaces it, so `ms-probe`'s postinst comes after `ms`'s
# prerm and enables and starts the probe again (`smoke-packages.sh` swaps on both).
#
# **Disabled by hand as well.** By the time this runs the unit file has gone with the package, and
# `systemctl disable` on systemd 252 (EL9) leaves the enable link of a unit it has no file for —
# found by `smoke-packages.sh`, a link pointing at nothing, for a unit every boot would try to
# start. So a link by that name that leads nowhere is removed here; one that leads to a unit file,
# an operator's copy in /etc, is systemd's, and `disable` above has had its say about it.
ms_probe_setup=/opt/ms/libexec/ms-setup
ms_probe_links=/etc/systemd/system
if [ -x "${ms_probe_setup}" ]; then
  echo "note: ms-probe.service was left as it is: ${ms_probe_setup} is still installed" >&2
  echo "      (ms or ms-probe), and the probe it sets up runs from that unit." >&2
else
  systemctl stop ms-probe.service >/dev/null 2>&1 || :
  systemctl disable ms-probe.service >/dev/null 2>&1 || :
  for ms_probe_link in "${ms_probe_links}"/*.wants/ms-probe.service; do
    if [ -L "${ms_probe_link}" ] && [ ! -e "${ms_probe_link}" ]; then
      rm -f "${ms_probe_link}" || :
    fi
  done
fi
