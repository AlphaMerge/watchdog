#!/usr/bin/env bash
# ms-recover: bring a service that kept crashing back after a cool-down (H-23).
#
#     ms-recover ms-probe          what OnFailure=ms-recover@%N.service runs when the unit fails
#     ms-recover --now ms-probe    what the retry timer that scheduled runs, when it is due
#
# **The start limit stops a crash loop, and until H-23 nothing started it again.** Five starts
# inside ten minutes leave the unit `failed` (P-215), which keeps a loop from raising an alarm
# every round. It also left a remote probe down until somebody visited it: P-216b's probe, killed
# six times in ten minutes by the kernel, stayed `failed` with nothing to bring it back.
#
# **Only a unit the start limit stopped is started again**, and `Result=` does not say which that
# is. A crash loop that runs into the limit keeps the crash's own result (`signal`, `exit-code`,
# `watchdog`), and `start-limit-hit` appears only when a start somebody asked for is refused. What
# marks the loop is that systemd was restarting the unit and the restart it scheduled never ran:
# the unit fails RestartSec after its process exited, where a refusal or a stop fails it in the
# same instant. Measured (H-23) on ms-probe on Debian 12, and on a unit with its restart settings
# on the other two:
#
#     what failed the unit               Result=          Debian 12  Rocky 9  Ubuntu 24.04
#     crash loop, sixth start refused    signal           5.02 s     5.15 s   5.07 s
#     configuration refused (exit 78)    exit-code        0.16 ms    0.28 ms  0.12 ms
#     `systemctl stop` that timed out    timeout          0.17 ms    0.19 ms  1.47 ms
#     manual start the limit refused     start-limit-hit  75 ms      -        -
#
# The times are from the process exiting to the unit failing, under systemd 252, 252 and 255.
#
# So, in order: exit 78 is always left for a person, as P-222 decided, since a refused file is
# refused again every time. `start-limit-hit` is a refused start. Otherwise it is a crash loop
# when systemd had restarted the unit and it failed at least half its RestartSec after its
# process exited. A stop the operator asked for is theirs, even when it timed out.
#
# **The cool-down doubles**, from 10 minutes to a cap of 4 hours, and starts again once the service
# has stayed up for an hour. Ten minutes is the units' StartLimitIntervalSec, so a retry never
# lands in the window that just filled. Each retry is a new loop of up to five starts. Without a
# recovery hold each loop could raise an alarm or two, which the cap bounded at about six a day;
# Probe Health's five-minute hold (M-18) makes every retry of it one outage and one alarm.
#
# **Why not RestartSteps= and RestartMaxDelaySec=.** They need systemd 254, and Debian 12 and
# RHEL 9 ship 252, which warns about them on every reload. They also back off only while the start
# limit is not hit, so using them would mean giving up P-215's limit and the alarm bound it buys.
#
# **Why a timer made here rather than a .timer unit.** A unit's delay is fixed, and one that has
# fired stays "elapsed", so the next start of it does nothing: the second retry would silently
# never happen. `systemd-run --on-active` makes a new timer each time, with this attempt's delay,
# and `--collect` removes it once it has run.
#
# Every decision is one line in the journal, from the failure and from the retry it scheduled:
# `journalctl -u 'ms-recover*'`.
#
# To keep a crashing service down: `systemctl disable` it, which this respects, or stop the
# pending retry with `systemctl stop ms-recover-<unit>-retry.timer`.
set -euo pipefail

# Test hooks, and the smoke test's shorter cool-down. Not settings: an operator who wants a
# different schedule is asking a question H-23 answered, and should say so.
BASE_SEC="${MS_RECOVER_BASE_SEC:-600}"
CAP_SEC="${MS_RECOVER_CAP_SEC:-14400}"
HEALTHY_SEC="${MS_RECOVER_HEALTHY_SEC:-3600}"
STATE_DIR="${MS_RECOVER_STATE_DIR:-/run/ms-recover}"
SELF="${MS_RECOVER_SELF:-/opt/ms/bin/ms-recover}"

say() { echo "ms-recover: $*"; }
die() { echo "ms-recover: $*" >&2; exit 2; }

mode=schedule
if [ "${1:-}" = --now ]; then
  mode=now
  shift
fi
name="${1:-}"
# Only these two. The template could be instantiated for any unit, and this runs as root.
case "${name}" in
  ms-core | ms-probe) ;;
  *) die "usage: ms-recover [--now] ms-core|ms-probe (got '${name}')" ;;
esac
unit="${name}.service"
timer="ms-recover-${name}-retry"
state="${STATE_DIR}/${name}"

# Seconds since boot. Not the wall clock, which an NTP step can move by hours between a retry and
# the failure after it; and the state lives in /run, so a reboot starts it again anyway.
now() {
  if [ -n "${MS_RECOVER_NOW:-}" ]; then
    echo "${MS_RECOVER_NOW}"
  else
    cut -d. -f1 /proc/uptime
  fi
}

show() { systemctl show "${unit}" -p "$1" --value 2>/dev/null || true; }

# `attempt retried_at`: how many retries this run of failures has had, and when the last one
# started the unit. Anything unreadable is a first attempt.
attempt=0
retried_at=''
if [ -f "${state}" ]; then
  read -r attempt retried_at <"${state}" || true
fi
case "${attempt}" in '' | *[!0-9]*) attempt=0 ;; esac
case "${retried_at}" in *[!0-9]*) retried_at='' ;; esac

remember() {
  install -d -m 0755 "${STATE_DIR}"
  printf '%s %s\n' "$1" "$2" >"${state}.tmp"
  mv -f "${state}.tmp" "${state}"
}

digits() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; }

# The unit's RestartSec in microseconds, as systemd holds it: `systemctl show` prints it formatted
# ("5s"), and an operator's drop-in may have changed it. Empty when it cannot be read.
restart_usec() {
  local reply
  reply="$(busctl get-property org.freedesktop.systemd1 \
    "/org/freedesktop/systemd1/unit/${name//-/_2d}_2eservice" \
    org.freedesktop.systemd1.Service RestartUSec 2>/dev/null || true)"
  echo "${reply#t }"
}

# Whether the unit failed because the start limit refused it, as the header describes. Asked on
# both passes: the operator may have acted in the ten minutes to four hours between them.
crash_looped() {
  local result restarts exited changed restart enabled
  result="$(show Result)"
  if [ "$(show ExecMainCode)" = 1 ] && [ "$(show ExecMainStatus)" = 78 ]; then
    say "${unit} refused its configuration (exit 78): not a crash loop, so it is left for a person"
    return 1
  fi
  if [ "${result}" != start-limit-hit ]; then
    restarts="$(show NRestarts)"
    # Monotonic, both: the wall-clock pair moves with the clock, and NTP stepping it at boot is
    # exactly when a service is most likely to be crash-looping.
    exited="$(show ExecMainExitTimestampMonotonic)"
    changed="$(show StateChangeTimestampMonotonic)"
    restart="$(restart_usec)"
    if ! digits "${restarts}" || ! digits "${exited}" || ! digits "${changed}" \
      || ! digits "${restart}"; then
      say "${unit} is failed, but systemd's record of it cannot be read, so it is left alone"
      return 1
    fi
    # Below a second, the wait before a refused restart is too short to tell from the instant a
    # stop or a refusal fails the unit. Left alone, which is what the units did before H-23, and
    # `ms-setup` warns about such a drop-in when it installs.
    if [ "${restart}" -lt 1000000 ]; then
      say "${unit} is failed, but its RestartSec is below 1 s: a refused restart cannot be told from a stop, so it is left alone"
      return 1
    fi
    # Half of RestartSec: the loop measured at 5.02 s against a RestartSec of 5, and the stop and
    # the refusal at under a millisecond.
    if [ "${restarts}" -eq 0 ] || [ $((changed - exited)) -lt $((restart / 2)) ]; then
      say "${unit} is $(systemctl is-active "${unit}" 2>/dev/null || true) (result: ${result:-none}): not a crash loop, so it is left alone"
      return 1
    fi
  fi
  enabled="$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
  if [ "${enabled}" != enabled ]; then
    say "${unit} stopped after repeated crashes, but it is ${enabled:-not enabled}, so it is left down"
    return 1
  fi
}

if [ "${mode}" = now ]; then
  if ! systemctl is-failed --quiet "${unit}"; then
    say "${unit} is $(systemctl is-active "${unit}" 2>/dev/null || true) already: nothing to do"
    exit 0
  fi
  crash_looped || exit 0
  remember "${attempt}" "$(now)"
  # Clears the start limit's count as well as the failure: without it, the start is refused.
  systemctl reset-failed "${unit}"
  systemctl start --no-block "${unit}"
  say "starting ${unit} again (attempt ${attempt})"
  exit 0
fi

crash_looped || exit 0

# A service that stayed up for an hour after the last retry is having a new problem, not the old
# one again, and starts from the shortest cool-down.
if [ -n "${retried_at}" ] && [ $(($(now) - retried_at)) -ge "${HEALTHY_SEC}" ]; then
  attempt=0
fi
delay="${BASE_SEC}"
for ((i = 0; i < attempt && delay < CAP_SEC; i++)); do delay=$((delay * 2)); done
[ "${delay}" -le "${CAP_SEC}" ] || delay="${CAP_SEC}"
attempt=$((attempt + 1))

# One retry pending at a time: this failure's replaces any left from before.
systemctl stop "${timer}.timer" >/dev/null 2>&1 || true
systemd-run --quiet --collect --unit="${timer}" --on-active="${delay}" \
  --timer-property=AccuracySec=10s \
  --description="Start ${unit} again after repeated crashes (H-23)" \
  "${SELF}" --now "${name}"
remember "${attempt}" "${retried_at}"

# In minutes, which every shipped cool-down is; seconds for the smoke test's shorter one.
if [ $((delay % 60)) -eq 0 ]; then in="$((delay / 60)) min"; else in="${delay} s"; fi
say "${unit} stopped after repeated crashes; starting it again in ${in}, at $(date -d "+${delay} seconds" '+%H:%M') (attempt ${attempt})."
say "  To keep it down: systemctl stop ${timer}.timer, or systemctl disable ${unit}"
