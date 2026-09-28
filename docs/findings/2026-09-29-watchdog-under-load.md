# Does CPU starvation alone make systemd's watchdog kill an idle service? (`P-220`)

**No.** Both services ran under the shipped units in a clean systemd box through a CPU hog of
up to six busy loops per CPU. That meant a load of 50.6 on 8 CPUs and CPU pressure (`some`) at
95%. systemd killed nothing and restarted nothing. `NRestarts` stayed 0 for both units in
every stage. The longest PID 1 went without a ping was 15.05 s, against `WatchdogSec=30`. Every
ping the services sent succeeded, and the slowest took 152 ms.

So CPU contention does not reproduce `P-215`'s kills on its own. The incident's host also had
**memory** pressure: `full` at 18%, and swap exhausted. This run had memory `full` at 0 from start
to end. Memory is now the prime suspect, and the next stage starves it on purpose (below).

## How it was measured

`scripts/sizing/watchdog-under-load.sh` on `dac9d43`, on 2026-09-28 from 21:32:59 UTC:

- **The box.** The box `smoke-install.sh` keeps: Debian 12, systemd 252 (252.39-1~deb12u2),
  8 CPUs. Both services ran from the release tarball under `deploy/systemd/`, and the probe was
  approved and connected.
- **Sent.** A wrapper in front of `systemd-notify` recorded each helper's start, finish and exit.
- **Received.** `WatchdogTimestampMonotonic`, read every second, is when PID 1 last accepted a
  ping.
- **The event loops.** The core's `/metrics` loop-lag maximum, and the probe's scheduler lag and
  heartbeat age from Probe Health, every five seconds.
- **Pressure.** `/proc/pressure/{cpu,memory,io}` `avg10`, and the load average, every second.

**Conditions.** The machine was booked: every other session had reported idle before the go
file was touched. `ms-server` was *not* running. It had been in a Docker restart loop since
21:29 the day before, exiting 78 on a migration that had been edited after it was applied. So
the 5,000-sensor dev probe that was beside `P-215`'s rerun was absent. The host was quieter
than the incident's, which makes the negative stronger for CPU and says nothing about memory.

## Per stage

| Stage | Busy loops | Seconds | Load (max) | CPU `some` (max) | Memory `full` (max) | IO `some` (max) | Longest ping gap, core / probe | Pings sent, core / probe | Slowest send, core / probe | Core loop lag (max) | Probe scheduler lag (max) | Restarts |
| ----- | ---------: | ------: | ---------: | ---------------: | ------------------: | --------------: | ------------------------------: | -----------------------: | -------------------------: | ------------------: | ------------------------: | -------: |
| 0     |          0 |     180 |       2.14 |            0.68% |                  0% |           0.72% |                  14.9 / 14.9 s |                  12 / 12 |               12 / 11 ms |           1,049 ms¹ |                    9.5 ms |        0 |
| 1     |          8 |     240 |      11.35 |           23.84% |                  0% |           2.94% |                  14.9 / 15.0 s |                  16 / 16 |               77 / 82 ms |              261 ms |                    9.5 ms |        0 |
| 3     |         24 |     300 |      25.57 |           91.54% |                  0% |           2.47% |                  14.7 / 15.0 s |                  20 / 20 |               76 / 46 ms |              322 ms |                    9.4 ms |        0 |
| 6     |         48 |     300 |      50.57 |           95.14% |                  0% |           2.48% |                  15.0 / 15.1 s |                  20 / 20 |              152 / 98 ms |              495 ms |                   11.4 ms |        0 |

¹ The first scrape after start-up. The maximum resets at each scrape, and the rest of the baseline
was far lower.

A ping gap of 15 s is the services' ping interval, so PID 1 took each ping on time. Nothing in any
stage came near the 30 s limit.

## What went wrong in the harness

The run failed at its very end, after the last stage. It read PID 1's journal (at debug for the
run) through `execFileSync`, whose output buffer is 1 MiB, and the journal was larger:
`spawnSync journalctl ENOBUFS`. That lost the received-side PID 1 records, meaning notifications
PID 1 could not attribute. The per-second `WatchdogTimestampMonotonic` readings cover the same
question from the other side: every ping gap was the send interval. The sent records and the
ticks are complete. The harness now streams the journal to a file and reads it line by line.

`2026-09-29-watchdog-under-load-cpu.jsonl` holds every record of the run except the one-second
ticks between the five-second ones. Those carry the same fields, less the loop lag, and the full
file was twice the size of any other findings file here.

## Next

A memory stage, sized to the box's own cgroup rather than to the shared VM. The dev PostgreSQL
went into crash recovery (`57P03`) under memory pressure the same night, with four suites
running, so a balloon sized to the VM would reproduce that crash. It runs in `P-216`'s window,
with this harness's watchdog readings attached, because `P-216`'s probe grew and went silent on
the same starved host. One booked window then answers both questions: whether memory pressure
makes systemd kill a service, and whether a probe grows when its log stalls.
