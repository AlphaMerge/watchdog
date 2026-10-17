#!/usr/bin/env bash
# What runs inside the ms-server container (`scripts/dev-services.sh`): ms-core and ms-probe, and
# an exit when either stops.
#
# A restart policy only acts when the container exits, so the container must exit when *either*
# process does: with the probe as the only foreground process, a core that died on start —
# PostgreSQL not up yet after a reboot, and a failed migration is fatal — left a container that
# looked healthy and a UI answering 502. The survivor is stopped, and Docker starts both again.
#
# **Liveness is polled, not waited for with `wait -n`.** The first version ended in
# `wait -n $core $probe`, and on 2026-09-15 the core died with ENOTFOUND postgres 1.3 s after a
# Docker restart — inside the pause below, before `wait -n` was reached. Run as `bash -c` (which
# is how this was run then), bash 5.2 had already disposed of the core's job: `wait -n` said
# "wait: 9: no such job" and waited on the probe alone, and the container stayed Up for ten hours
# with no core in it. Run as a file, the same code happens to work. A loop of `kill -0` does not
# depend on which of those bash is doing, and `wait <pid>` still returns a reaped child's status.
# `scripts/test-ms-server-supervisor.sh` runs every case both ways.
#
# SIGTERM is passed on to both so `docker stop` and a Docker shutdown let them close cleanly. Every
# sleep runs in the background and is waited for, so a stop during one is not held for its length.
#
# **What runs is `MS_SERVER_BUILD`'s, and where it keeps its state is the working directory's**
# (`H-24`). `dev-services.sh` points it at ms-server's own build of origin/main, so only a landed
# migration ever reaches the shared development database, while the data directory, the
# certificates and the vault key stay the checkout's `dev/` — the paths in the config file are
# relative to the working directory. Unset, it is the working directory, as it was.
build="${MS_SERVER_BUILD:-.}"

core=""
probe=""

stop_both() {
  # shellcheck disable=SC2086 # empty when the probe was never started
  kill -TERM $core $probe 2>/dev/null || true
  wait
}
trap 'stop_both; exit 143' TERM INT

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

node "${build}/packages/core/dist/src/main.js" --config "${build}/dev/core.json" &
core=$!

# The core first, so the probe's first dial usually finds it listening — and no probe at all for a
# core that is already gone.
sleep 3 &
wait $!
if alive "${core}"; then
  # The probe's thread pool as the shipped unit and launcher set it (`P-426`): at libuv's default 4
  # its resolver has 3 lanes on 2 of libuv's, and the instance kept to watch landed code would not
  # behave as a shipped probe does. Not the core's, as in the units.
  UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}" \
    node "${build}/packages/probe/dist/src/main.js" --config "${build}/dev/probe.json" &
  probe=$!
fi

while alive "${core}" && alive "${probe}"; do
  sleep 1 &
  wait $!
done

if alive "${core}"; then
  which=probe
  wait "${probe}"
  status=$?
else
  which=core
  wait "${core}"
  status=$?
fi
echo "ms-server: the ${which} exited with status ${status}; stopping the other so Docker restarts both" >&2
stop_both
exit $((status == 0 ? 1 : status))
