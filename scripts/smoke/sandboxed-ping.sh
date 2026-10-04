#!/usr/bin/env bash
# `ping -c1 <target>` as ms-probe, inside ms-probe.service's own sandbox (`H-31`). Run in a smoke box.
#
#     sandboxed-ping.sh [target]      # 127.0.0.1 by default; exits as ping did
#
# **The unit's settings, read from the installed unit, not a copy of them.** Every line of its
# [Service] section is handed to a transient unit, except the ones that say how the service's own
# process is run and supervised — so a capability, an address family or a privilege setting added
# to the unit later is in this run without anybody remembering to add it here. A ping that works
# as ms-probe outside the unit proves nothing: `/usr/bin/ping` carries `cap_net_raw`, and the unit
# is what takes it away (`NoNewPrivileges=`, `CapabilityBoundingSet=`).
set -euo pipefail

target="${1:-127.0.0.1}"
unit="$(systemctl show ms-probe.service -p FragmentPath --value)"
[ -f "${unit}" ] || { echo "no ms-probe.service installed (${unit:-none})" >&2; exit 2; }

props=()
in_service=0
while IFS= read -r line; do
  case "${line}" in
    '[Service]') in_service=1; continue ;;
    '['*) in_service=0; continue ;;
    '' | '#'*) continue ;;
  esac
  [ "${in_service}" -eq 1 ] || continue
  case "${line%%=*}" in
    Type | NotifyAccess | TimeoutStartSec | WatchdogSec | Restart | RestartSec | \
      RestartPreventExitStatus | ExecStart | KillSignal | KillMode | TimeoutStopSec | \
      StateDirectory | LogsDirectory | RuntimeDirectory) continue ;;
  esac
  props+=(-p "${line}")
done <"${unit}"

# A parse that carried nothing would run ping as root with no sandbox and pass.
for needed in User=ms-probe NoNewPrivileges=yes CapabilityBoundingSet= RestrictAddressFamilies=; do
  case " ${props[*]} " in
    *" ${needed}"*) ;;
    *) echo "the sandbox lost ${needed} on the way from ${unit}" >&2; exit 2 ;;
  esac
done

exec systemd-run --quiet --wait --pipe --collect "${props[@]}" \
  ping -n -c1 -W2 "${target}"
