#!/usr/bin/env bash
# What the kernel does to a cgroup at its `memory.high`, for `P-210`.
#
#     scripts/sizing/cgroup-high-behaviour.sh [out.jsonl]
#
# Two containers, each with `memory.high` at 200 MiB, `memory.max` at 600 MiB and no swap, each
# sampled every second from *outside* its cgroup — from inside, the sampler is throttled with
# everything else, and `docker exec` into a throttled cgroup hangs:
#
#   anon    Node allocates 32 MiB at a time past `memory.high`. Is it stopped, killed, or slowed?
#   cache   dd writes 400 MB of file data through it. Does `memory.current` reach the ceiling,
#           and is anything actually slowed?
#
# And one more, unsampled: with 180 MB of page cache in the same 200 MiB, what Node's own
# `process.constrainedMemory()` and `process.availableMemory()` say against the working set.
#
# One JSON line per sample: memory.current, the working set (current less inactive_file), the
# `high` and `oom_kill` event counts, and memory PSI's `some avg10` — the share of the last ten
# seconds something in the cgroup was stalled on memory. Then each container's own log, as lines
# with a `log` key, so the allocation times are in the record and not only on the terminal. The
# first line is the VM's load when the run began: the allocation times are CPU-bound as well as
# memory-bound, and a busy VM stretches them.
#
# Development only: it needs `--privileged` to write `memory.high` inside the container.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${1:-${repo_root}/docs/findings/$(date -u +%Y-%m-%d)-cgroup-high-behaviour.jsonl}"
seconds="${MS_CGROUP_SECONDS:-40}"
image=node:24-bookworm
# The VM's own load, not the Mac's: every container reads the VM's /proc/loadavg.
docker run --rm alpine:3.20 sh -c \
  'printf "{\"cpus\":%d,\"loadavg\":\"%s\"}\n" "$(nproc)" "$(cut -d" " -f1-3 /proc/loadavg)"' >"${out}"

run() {
  local name="$1" workload="$2" cid pid
  cid="$(docker run -d --privileged --cgroupns=private --memory=600m --memory-swap=600m \
    "${image}" sh -c "echo 200M > /sys/fs/cgroup/memory.high; ${workload}")"
  pid="$(docker inspect -f '{{.State.Pid}}' "${cid}")"
  # From the host's cgroup namespace, so the sampler is outside the cgroup it is watching.
  docker run --rm --privileged --pid=host --cgroupns=host alpine:3.20 sh -c "
    d=/sys/fs/cgroup\$(cut -d: -f3 /proc/${pid}/cgroup)
    i=0
    while [ \$i -lt ${seconds} ] && [ -d \"\$d\" ]; do
      cur=\$(cat \$d/memory.current)
      ina=\$(awk '/^inactive_file /{print \$2}' \$d/memory.stat)
      high=\$(awk '/^high /{print \$2}' \$d/memory.events)
      kills=\$(awk '/^oom_kill /{print \$2}' \$d/memory.events)
      psi=\$(sed -n 's/^some avg10=\\([0-9.]*\\).*/\\1/p' \$d/memory.pressure)
      printf '{\"workload\":\"${name}\",\"t\":%d,\"currentMiB\":%d,\"workingSetMiB\":%d,\"highEvents\":%d,\"oomKills\":%d,\"stalledPercent\":%s}\n' \
        \$i \$((cur/1048576)) \$(((cur-ina)/1048576)) \$high \$kills \$psi
      i=\$((i+1))
      sleep 1
    done" >>"${out}"
  docker logs "${cid}" 2>&1 | while IFS= read -r line; do
    echo "${name}: ${line}"
    printf '{"workload":"%s","log":"%s"}\n' "${name}" "${line}" >>"${out}"
  done
  docker rm -f "${cid}" >/dev/null
}

run anon 'node -e "
  const held = [];
  for (let i = 1; i <= 10; i += 1) {
    const at = Date.now();
    const chunk = Buffer.allocUnsafeSlow(32 << 20);
    chunk.fill(1);
    held.push(chunk);
    console.log(\"held \" + i * 32 + \" MiB, that allocation took \" + (Date.now() - at) + \" ms\");
  }"'
run cache 'at=$(date +%s%N); dd if=/dev/zero of=/var/tmp/cache.bin bs=1M count=400 conv=fsync 2>/dev/null;
  echo "wrote 400 MB in $(( ($(date +%s%N) - at) / 1000000 )) ms"; sleep 60'

# What `P-210`'s ticket proposed reading instead. One JSON line, from Node itself.
docker run --rm --privileged --cgroupns=private --memory=600m --memory-swap=600m "${image}" sh -c '
  echo 200M > /sys/fs/cgroup/memory.high
  dd if=/dev/zero of=/var/tmp/cache.bin bs=1M count=180 conv=fsync 2>/dev/null
  node -e "
    const { readFileSync } = require(\"node:fs\");
    const MiB = 1024 * 1024;
    const current = Number(readFileSync(\"/sys/fs/cgroup/memory.current\", \"utf8\"));
    const stat = readFileSync(\"/sys/fs/cgroup/memory.stat\", \"utf8\");
    const inactiveFile = Number(/^inactive_file (\\d+)$/m.exec(stat)[1]);
    console.log(JSON.stringify({
      workload: \"node-api\",
      uv: process.versions.uv,
      constrainedMiB: Math.round(process.constrainedMemory() / MiB),
      availableMiB: Math.round(process.availableMemory() / MiB),
      currentMiB: Math.round(current / MiB),
      workingSetMiB: Math.round((current - inactiveFile) / MiB),
    }));"' | tee -a "${out}"

echo "==> $(wc -l <"${out}") lines in ${out}"
