# Cutting `v1.0.0-rc.3` — the checklist, 2026-10-19

- **What this is**: the procedure the rc.2 cut followed
  ([its record](2026-10-04-v1-release-candidate-cut.md), from
  [the proposal's §4](2026-09-28-v1-release-candidate.md)), with every command written out, so that
  the cut is run from this page and not from memory. **Nothing here has been run yet.** It was
  written before `P-432`'s S3, S6 and S8 landed, and brought onto them on 2026-10-20 (`H-50`,
  on `a95c3302`, where they were integrated): every `TODO(rc3-cut)` marker the documents carried
  for them is resolved against that code. The rest were built the same day and integrated on
  `integ/r6-1020`, with this page brought onto them: the gate track's second round (`P-453` and
  S6's re-check gaps), S7's perf arms and its findings file, and `P-460` and `P-461` (S8's
  second recording and its boxes, run 7). Then on `integ/r7-1020`: `P-467` (Probe Health's six
  name fields, the rest in the probe's log), `P-463` and `P-469` (the lookup helper's quiets and
  who sent a SIGKILL), `P-465` and `P-471` (S7's `spread10`, `addresses` and `walkrate`, and its
  helper arms re-read), and `P-462` (§7.5's other rows in the differential, run 9, whose
  recordings are committed). Their landing on `origin/main` is what step 0.1 checks by name, and
  the cut does not start without it. What only the cut can say (the commit,
  the dates, the checksums, S7's full-size numbers) stays a `<…>` placeholder or a
  `TODO(quiet-window)`, filled in step 9.
- **What it adds to rc.2's procedure**: the x86_64 build and its smokes as steps, not a ticket
  (`H-14`); the probe host's packages in the record, since the field test now installs remote
  probes (runbook step 1); `P-432`'s differential as a gate, by the user's decision of 2026-10-18,
  in all seven images and with the name check's own questions beside glibc's (`P-460`), and the
  gate's full-size measurement (S7), both on the commit to be cut; and a check, at each artefact,
  of the three things rc.1 got wrong (below).
- **Who runs it**: the orchestrating session, after saying what is being cut. The user's approval
  of 2026-10-17 covers the version commit, the arm64 and amd64 tarballs, `.deb` and `.rpm` built in
  `dev.sh` with `MS_BUILD_COMMIT`, the four smokes and the runbook's *Last verified* dates. It does
  not cover publishing the packages anywhere, or tagging `v1.0.0`.

**Every block below stands alone.** It starts with its own `cd` and reads the commit from git,
because the shell that runs it keeps no variables or directory from the block before (the
orchestrator's tool starts each command afresh). Before each build or smoke, check the VM (step
0.5).

## What rc.1 got wrong, and where this checks it

| rc.1's mistake | What it cost | Checked at |
| --- | --- | --- |
| The package's version was the tag's, `1.0.0-rc.1`. `rpmbuild` refuses a `-` in `Version:`, and `dpkg` reads what follows the last `-` as a revision, so `1.0.0-rc.1` sorted after `1.0.0` | No `.rpm`; a `.deb` that `1.0.0` would have refused to upgrade | Step 6: the file names, `Version:` in both, and `dpkg --compare-versions` and `rpm.vercmp` against `1.0.0` and rc.2 |
| The packages were built from rc.1's staged tree by scripts fixed after the tag | `smoke-packages.sh` refused them: the package said `48ee0be9`, clean, and the checkout running the test was not | Steps 4 and 6: one worktree at the tag, clean, builds everything, and every `build.json` is compared with the tag's commit |
| The first tarball was built with a commit hash typed from memory, which named no commit | A manifest that lied, caught before publishing | Steps 3 and 4: the hash is read from git into a variable and never typed; step 4 asks git whether the stamped commit exists |

`scripts/package.sh`, `package-deb.sh` and `package-rpm.sh` were read for this on 2026-10-19 at
`f762dfc6`, and produce rc.3 correctly with no change. `package.sh` takes the version from the root
`package.json` (`node -p`), and names the staged tree `build/ms-1.0.0-rc.3` and the tarball
`ms-1.0.0-rc.3-linux-<arch>.tar.gz`, with `VERSION` and both `build.json` saying `1.0.0-rc.3`.
`package-deb.sh` and `package-rpm.sh` read the same file (by `sed` in their Debian and Rocky
containers, where there is no `node`), find the same staged tree, and give the package manager
`${version/-/${tilde}}` with `tilde="~"`: `1.0.0~rc.3`. That is `ms_1.0.0~rc.3_<arch>.deb` and
`ms-1.0.0~rc.3-1.<arch>.rpm`, whose `%setup` directory, `ms-1.0.0~rc.3`, is the one the script lays
out. `MS_BUILD_VERSION` is not passed into either container, so **never use it for a cut**: the
version comes from the version commit, or the package scripts look for a staged tree that is not
there and stop. `package-msi.sh` would write `1.0.0-rc.3.0` as an MSI `ProductVersion`, which
Windows Installer refuses; Windows is release 1.1, and that is `H-49`.

## 0. Before anything is built

Each of these is a yes, or the cut waits.

1. **`P-432` has landed whole**: S1 to S8 on `origin/main`, S7 with its findings file
   (`2026-10-20-name-lookups-gated.md` in `docs/findings/`); the four things the coordinator
   put in 1.0 before this cut on 2026-10-20 (`P-432`'s outcome in `TASKS.md`): `P-453` (a child
   killed from outside poisons no name), `P-460` (the differential records the check's questions
   too), `P-461` (boxes that show the check off), and S6's re-check gaps (no avoided name started
   from the probe's queues, or settled after `stop()`); and the three it put in after them (its
   decisions for rc.3, also under `P-432`): `P-462` (the differential replays §7.5's other rows),
   `P-463` (names in flight when the helper goes quiet kept off the probe's lanes) and `P-465`
   (`spread10` and `walkrate`, which step 0.7 runs), with `P-469` for its decision that a
   SIGKILL the probe sent is told apart from one from outside. And `P-467`: S6's eight Probe
   Health fields out by the user's decision of 2026-10-18 (OPEN-5), so the cut speaks protocol 38
   with six name fields, and the field test reads the rest from the probe's hourly summary.
   `P-454` stays open: it is a known limit in the release notes.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem
   git fetch -q origin
   git log --oneline origin/main | grep -E 'P-432 S[0-9]'    # S1 to S8, each at least once
   git cat-file -e origin/main:docs/findings/2026-10-20-name-lookups-gated.md && echo "S7's findings"
   git show origin/main:docs/TASKS.md | grep -cE '^- \[x\] \*\*(P-453|P-460|P-461|P-462|P-463|P-465|P-467|P-469) '    # 8
   git show origin/main:packages/shared/src/protocol/messages.ts | grep -c 'PROTOCOL_VERSION = 38;'    # 1
   ```

   The S6 gaps have no ticket of their own: the gate track's second round closed them, beside
   `P-453` (`P-432`'s outcome, *The gate track's second round built*). Name its commit in the
   record:

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem
   git log --oneline origin/main | grep -F "P-432: the gate track's second round"    # once
   ```

2. **The differential's recordings are committed** (the user's decision of 2026-10-18: against
   `getaddrinfo`, `systemd-resolved` included). `P-432` S8 ran it in boxes of each distribution's
   own image rather than the smoke images, since the glibc and the NSS modules are the
   distribution's either way (S8's outcome, decided 2026-10-20): Rocky 8 and 9, Debian 11, 12 and
   13, Ubuntu 22.04 and 24.04. The fixture is S8's run 9 (`P-462`'s fix round 1), schema 3: glibc's
   wire for every image, each question's OPT record with it, 3,008 recordings, 42 for the six
   answer rows, one in each image, and 49 for the two sequence rows' seven lookups, in each image,
   and Ubuntu 24.04's run went through `systemd-resolved`. It holds no walk recording: the walk is
   judged in the run against glibc's, never committed (`P-460`'s decision):

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
   git show origin/main:packages/probe/test/fixtures/system-names-recordings.json | python3 -I -c '
   import json, sys
   r = json.load(sys.stdin)
   images = r["images"]
   print(sorted(images), "recordings:", len(r["recordings"]))
   assert sorted(images) == ["debian11", "debian12", "debian13", "rocky8", "rocky9", "ubuntu2204", "ubuntu2404"], images
   assert images["ubuntu2404"]["resolved"] is True
   assert r["schema"] == 3 and len(r["recordings"]) == 3008 and len(r["answerRecordings"]) == 42
   assert len(r["sequenceRecordings"]) == 49
   print("policy build", sorted({i["policyDigest"][:8] for i in images.values()}))
   '
   ```

   Step 0.6 runs it again, on the commit to be cut. The recordings name the policy build they were
   made on (`ae2c892f…`, `system-names.js` with `P-462`'s `skewedFiles`), which is the build of
   that file on `integ/r7-1020`, where the four tracks of 2026-10-20 were integrated: none of the
   others changed it. A change to that file landed after it makes step 0.6 replay a newer build
   than the recordings name. That is expected: its verdict holds each run to the build it loaded,
   never to the recordings' digest, and it does not rewrite them. Write both digests in the
   record.

3. **No `TODO(rc3-cut)` marker is left in the documents** that ship in `/opt/ms/docs`. Each is
   resolved against the landed code in a docs commit on `main`, before step 0.4, so that the
   suite, the differential and the measurement run on the commit that is cut; the version commit
   changes nothing but versions. This page's own markers go with them. The pattern is written so
   that it does not find itself:

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
   git grep -nE '<!-- TODO[(]rc3-cut[)]' origin/main -- docs    # prints nothing
   ```

4. **The full suite is green on the commit to be cut**, by `scripts/test-all.sh`, in a detached
   worktree at `origin/main` and nowhere else: the main checkout can be on another commit or hold
   changes. It fails on `cancelled`, and prints `﹣` lines for skipped suites, which a bare summary
   hides. It bounds the suite and the lint inside the container, each by `MS_TEST_TIMEOUT`
   seconds (3,600 by default), so a hung suite stops its own toolchain container rather than
   leaving it counted in step 0.5; the host's alarm is above the two bounds together.
   This is a heavy run: start it only when step 0.5's count is under 2.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
   rm -f /tmp/rc3-suite-commit /tmp/rc3-diff-commit
   suite=/Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite
   if [ -e "${suite}" ]; then git worktree remove --force "${suite}" || exit 1; fi
   git worktree add --detach "${suite}" origin/main || exit 1
   cd "${suite}" || exit 1
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ -z "$(git status --porcelain)" ] || exit 1
   perl -e 'alarm 1260; exec @ARGV' ./scripts/dev.sh "timeout 1200 npm ci"
   MS_TEST_TIMEOUT=3600 perl -e 'alarm 7500; exec @ARGV' ./scripts/test-all.sh 2>&1 | tee /tmp/rc3-suite.out
   tail -n 1 /tmp/rc3-suite.out | grep -q '^==> clean\. Full log: ' && git rev-parse HEAD > /tmp/rc3-suite-commit
   cat /tmp/rc3-suite-commit       # the commit that passed, which step 1 compares with origin/main
   ```

   The last line must be `==> clean. Full log: …`, and only then does the block write
   `/tmp/rc3-suite-commit`. Write down its `tests · pass · fail · cancelled · skipped` line and
   every `﹣` line it lists, and compare them with the last green run's: `skipped 0`,
   `cancelled 0` and `fail 0`, and a `tests` total that fell names suites that did not run.
   `clean, but N suite(s) never ran` is not a pass, and writes no file; nor is a total that
   fell, so run `rm -f /tmp/rc3-suite-commit` then. A worktree an earlier attempt left is
   removed first, with its logs. Keep this one for steps 0.6 and 0.7, and remove it after them
   (`git worktree remove --force` on it, from the main checkout). Nothing else lands from here
   until step 7 has pushed: the version commit's parent must be the commit that passed, which
   step 1 checks against this file.
5. **The VM has room.** Builds and smokes are heavy: start one only when fewer than two toolchain
   runs are going, counting the amd64 project's too, and run the smokes one at a time.

   ```bash
   docker ps -q --filter name=toolchain-run | wc -l | tr -d ' '    # under 2
   ```

6. **The name gate's differential passes on the commit to be cut, in all seven images**
   (`scripts/smoke/name-gate-differential.sh`), in step 0.4's worktree. It judges which questions
   glibc and the check send, and of time only whether glibc returned within 1 s, which load cannot
   move a plan across (S8's findings: glibc took at most 164 ms on a plan whose walk was heard in run
   9, 232 ms in run 8 on a loaded VM, and at least 1,009 ms where it waited out a try), so it needs
   step 0.5's count under 2, not a quiet
   machine. Every image, with no `MS_DIFF_IMAGES` or `MS_DIFF_ONLY` (a narrowed run never
   verifies), on the digests the recordings were made on (no `MS_DIFF_REFRESH`), and without
   `MS_DIFF_WRITE`: the cut checks the committed recordings, it does not rewrite them. The boxes
   load the worktree's build, and the script refuses one older than its sources, so build first.
   With `P-462`'s rows and boxes the whole run takes about an hour (S8's run 9: 09:56 to 10:52
   UTC, with the host's load at 14; run 8 took 73 minutes on a VM loaded harder, and run 7, before
   `P-462`, 45), each image's replay 350–726 s in run 9.
   Each image's replay is bounded at 3,600 s inside its box, and the host's alarm is above the
   whole run.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite || exit 1
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ -z "$(git status --porcelain)" ] || exit 1
   [ "$(cat /tmp/rc3-suite-commit 2>/dev/null)" = "$(git rev-parse HEAD)" ] || { echo "step 0.4 has not passed on this commit"; exit 1; }
   rm -f /tmp/rc3-diff-commit
   perl -e 'alarm 660; exec @ARGV' ./scripts/dev.sh "timeout 600 npx tsc -b packages/probe"
   mkdir -p /tmp/rc3-diff
   MS_DIFF_OUT=/tmp/rc3-diff perl -e 'alarm 10800; exec @ARGV' ./scripts/smoke/name-gate-differential.sh 2>&1 | tee /tmp/rc3-diff/run.out
   tail -n 1 /tmp/rc3-diff/run.out | grep -q '^==> NAME GATE DIFFERENTIAL PASSED' && git rev-parse HEAD > /tmp/rc3-diff-commit
   cat /tmp/rc3-diff-commit        # the commit it passed on, which step 1 compares with origin/main
   ```

   It must end `==> NAME GATE DIFFERENTIAL PASSED (runs in /tmp/rc3-diff)`, with a
   `263 rows, 6 answer rows and 2 sequence rows in … s` line for each of the seven images (254
   rows on Rocky 8) and `systemd-resolved: active` for `ubuntu2404`. Any `FAILED` line, or `MS_DIFF_REFRESH` named
   because a recorded digest could no longer be pulled, stops the cut: a moved image is a new
   recording, made on `main` and reviewed, not at the cut, and the cut starts again from step 0.3
   on the commit that lands it. `git status --porcelain` in the worktree prints nothing afterwards.
   The block writes `/tmp/rc3-diff-commit` only on the `PASSED` line; a run that passes without
   step 0.6.1's lines is not a pass either, so run `rm -f /tmp/rc3-diff-commit` then.

   1. **`P-460`'s walk and `P-461`'s boxes, read as a step of their own.** The same run plays each
      plan a second time for the name check alone (`DnsCheck.route` with no lanes and no helper,
      its canary proven first) and fails where its questions differ from glibc's first asks: the
      names, types and servers in order up to where each stops, and heard if and only if glibc
      returned within 1 s (under `rotate`, silent wherever a server is, whatever glibc's time). It
      also holds gate mode's answers to `system` mode's and the helper's to the lanes', plays the
      six answer rows and the two sequence rows (`P-462`), and runs the budget boxes, the eleven
      boxes with the check off and the four skew boxes. The walk
      prints no line of its own: it is judged in the verdict, not recorded, so a walk, OPT,
      regression or answer row that disagrees is a `DISAGREES` line and fails the run. Read these
      in `run.out` before the `PASSED` line, each as S8's run 9 had it:
      - `<image>: <rows> rows, <plans> plans recorded` for each of the seven, 3,008 plans in all;
      - `answer rows: 42 plans recorded` and `sequence rows: 49 lookups recorded`;
      - five `budget …` lines: `dnsmasq system`, `gate` and `gate-kill`, and `resolved system`
        and `gate`, each `table full 0 times` at dnsmasq. Run 9 held 6, 8 and 10 distinct
        questions at once at dnsmasq (bounds 18 and 34, `system` + 12 and + 28) and 9 and 9 at
        resolved (bound 21, `system` + 12); the verdict holds the bounds, and the record copies
        the numbers;
      - eleven `off …` lines, each `route unvouched:off, 0 questions asked` and off by its rule:
        `nscd` (`nscd`); `resolve`, `files-resolve-dns` and `stub-refused` (Ubuntu 24.04),
        `mdns4_minimal`, `mdns4-first` and `sss-first` (`nsswitch`); `ld-preload`,
        `ld-so-preload` and `localdomain-empty` (`env`); and `nameserver-aton` (`resolv`);
      - four `skew …` lines, each `the check off by skew`: `gai` and `gai-not-first` with the
        restart said for `["/etc/gai.conf"]` and `nsswitch-frozen` for `["/etc/nsswitch.conf"]`,
        both after the edit and by the end, and after the SIGKILL the helper resting with no
        child, mode 3, trouble 1 and 0 lookups to the helper; and `nsswitch-reloaded` with the
        restart said for `[]`, and after the SIGKILL the helper up in a new child, mode 2 and
        trouble 0.

      A run with fewer of any of these has not tested the check, whatever its last line says,
      and the cut waits. Name in the record the recordings verified (step 0.2's) and the build
      the run judged (its `build …` line).

   Copy `/tmp/rc3-diff` beside the record before the worktree goes.

7. **S7's full-size name-lookups run, on the commit to be cut**, in step 0.4's worktree: the gate's
   `test:perf` arms, whose findings file is `2026-10-20-name-lookups-gated.md` in `docs/findings/`.
   Seven world arms in both modes (`slow`, `warmzone`, `zone`, `partial`, `steady`, `forwarder`,
   `spread10`) and eight in gate mode only (P1, P2, P3, P5, P5b, P6, `addresses`, `walkrate`), on
   S5's DNS simulator playing dnsmasq with 30 forwards left for the probe, glibc's wire held to the
   recordings, and the real helper, policy and walk, at 5,000 sensors. **A quiet window**:
   `ms-server` stopped, no other toolchain run, and the other projects' containers paused only with
   the user's leave, asked each time. The conditions print at the top of each run (`P-192`), and go
   in the record with the numbers. The commands are the two that findings file gives under *The
   quiet-window command*, at full size, about 125 minutes and then about 8 for the check-off half of
   `partial`; each waits 180 s first for the VM to settle after `ms-server`, and its bound is S7's
   plus that. `MS_DNS_ARMS` leaves out the lane model's arms, whose numbers are `P-426`'s third and
   fourth windows. The block stops `ms-server` itself, from the main checkout (`stop` removes the
   container, so Docker does not start it again), and refuses to go on while it or any toolchain run
   is up: the VM count in step 0.5 does not see `ms-server`, which is not a toolchain run, and
   `perf-conditions.mjs` warns and never blocks.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && ./scripts/dev-services.sh stop
   [ -z "$(docker ps -q --filter name='^ms-server$')" ] || { echo "ms-server is still up"; exit 1; }
   [ "$(docker ps -q --filter name=toolchain-run | wc -l | tr -d ' ')" = 0 ] || { echo "a toolchain run is going"; exit 1; }
   cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite || exit 1
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || exit 1
   [ "$(cat /tmp/rc3-suite-commit 2>/dev/null)" = "$(git rev-parse HEAD)" ] || { echo "step 0.4 has not passed on this commit"; exit 1; }
   mkdir -p /tmp/rc3-diff
   perl -e 'alarm 660; exec @ARGV' ./scripts/dev.sh "timeout 600 npx tsc -b"
   perl -e 'alarm 12300; exec @ARGV' ./scripts/dev.sh "timeout 12180 sh -c 'sleep 180; node scripts/perf-conditions.mjs; MS_DNS_RESOLVER=system,gate MS_DNS_WARM_MINUTES=7 MS_DNS_COLD_MINUTES=7 MS_DNS_STEADY_MINUTES=10 MS_DNS_ARMS=world/slow,world/warmzone,world/zone,world/partial,world/steady,world/forwarder,P1,P2,P3,P5,P5b,P6,world/spread10,world/addresses,world/walkrate node --test --test-concurrency=1 packages/probe/dist/test/perf/name-lookups.test.js'" 2>&1 | tee /tmp/rc3-diff/name-lookups.out
   perl -e 'alarm 1440; exec @ARGV' ./scripts/dev.sh "timeout 1380 sh -c 'sleep 180; node scripts/perf-conditions.mjs; MS_DNS_CHECK=off MS_DNS_RESOLVER=gate MS_DNS_COLD_MINUTES=7 MS_DNS_ARMS=world/partial node --test packages/probe/dist/test/perf/name-lookups.test.js'" 2>&1 | tee /tmp/rc3-diff/name-lookups-check-off.out
   for row in \
     'two names in five silent, twenty keys of ten, cold, the check off: system' \
     'two names in five silent, twenty keys of ten, cold, the check off: gate (check off)' \
     'every device given as an address, at walkrate’s load: walkrate’s baseline: gate' \
     'twice the names, one in ten silent, one sensor a device at twice the interval, cold: gate' \
     'held against spread10, system' 'held against addresses, gate'; do
     grep -qF "${row}" /tmp/rc3-diff/name-lookups.out || { echo "no row in the run: ${row}"; exit 1; }
   done
   ```

   The loop finds `P-465`'s rows: `spread10` in each mode, `addresses` and `walkrate`, and the two
   lines that say what each was held against. Before `P-465`'s fix round 1, `MS_DNS_ARMS` skipped
   a name no arm had, so a build without the arms ran none of them and still ended `fail 0`; the
   test file now stops on such a name, and the loop is the check for a build before that.
   Both runs pass (`fail 0`, `cancelled 0`): each arm's bounds are asserted in the run, by
   `name-gate-judge.ts` (the findings file's *Asserted in every arm* and its table of arms say which
   and why), so a bound crossed fails its arm. The findings file has no full-size numbers yet (its
   Results are `TODO(quiet-window)`): this run is the first, and its rows fill that table in step 9.
   Read, beside the bounds, what the arms print and do not assert: P5's and P5b's
   `lookupHelperTrouble` (1 after four kills in two minutes, as D27 says), P3's checks failed
   "otherwise", each arm's event-loop p50, p99 and max, and its routes. **P2 is the first full-size
   run on `P-463`'s build** (`P-472`, open): the names in flight when its child is stopped are kept
   off the probe's lanes, and its route reads `down` for about 17 s, so an answering name still
   unvouched at the SIGSTOP has its checks refused, which P2's judge fails. Scaled down on
   `integ/r7-1020` the walk vouched every answering name first and P2 held; at full size D19 sends
   most first lookups to the helper unvouched. A P2 that fails with answering checks failed
   otherwise is `P-472`'s case: it stops the cut as any failed arm does, and goes to `P-472` with
   the arm's lines. A result on the other side
   of the design's verdict for `gate` as the field test's setting (§9: the memory arms, the event
   loop's p99) stops the cut. That verdict also reads `spread10`'s event-loop p99 in each mode, with
   its lanes at risk, and `walkrate`'s against `addresses`', with its channels' busiest second
   (`P-465`): the record gives them. `spread10`'s line held against `system` also says how many
   answering checks `system` answered and how many the gate had to, and the arm fails where
   `system` answered too few for its bound to tell the two apart. Then, **however the block above
   ended**, `ms-server` is started from the main checkout and verified: it runs `origin/main`, both services name that commit at
   start, the probe connects, the log has no error line, and the API answers 401 without a
   credential. Unpause what was paused for the window (`docker unpause` on each).

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin && ./scripts/dev-services.sh start || exit 1
   perl -e 'alarm 300; exec @ARGV' sh -c 'until docker logs ms-server 2>&1 | grep -qF "connected to core"; do sleep 5; done' || { echo "the probe did not connect"; exit 1; }
   git rev-parse origin/main                                                      # the commit it runs
   docker logs ms-server 2>&1 | grep -oE '"commit":"[0-9a-f]+"' | sort -u         # that one, once
   docker logs ms-server 2>&1 | grep -c '"level":"error"'                         # 0
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/v1/objects/root   # 401
   ```

## 1. The commit, and a clean worktree for it

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
for passed in /tmp/rc3-suite-commit /tmp/rc3-diff-commit; do
  [ "$(cat "${passed}" 2>/dev/null)" = "$(git rev-parse origin/main)" ] \
    || { echo "origin/main is not the commit ${passed} names: cut again from step 0.3"; exit 1; }
done
git rev-parse origin/main       # the commit the suite (0.4), the differential (0.6) and S7 (0.7) ran on
git worktree add -b release/rc3 /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut origin/main || exit 1
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && git status --porcelain    # prints nothing
```

The loop stops the cut when `origin/main` is not the commit step 0.4's suite and step 0.6's
differential passed on, which is what a fix landed on `main` since then does: those steps, and
0.7, run again on the new commit first. S7's verdict is read from its numbers, not from a file,
so the record names the commit 0.7 ran on beside the other two. A second attempt stops at
`worktree add`, which refuses while the first attempt's branch or worktree is there: clear them
with step 3's block, then run this again.

## 2. The version commit

Every `package.json`, the internal `@ms/*` pins and the lockfile, from `1.0.0-rc.2` to
`1.0.0-rc.3`, and nothing else. rc.2's version commit (`0a43b7bf`) was exactly this replacement:
8 files, 31 lines each way.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut || exit 1
perl -pi -e 's/"1\.0\.0-rc\.2"/"1.0.0-rc.3"/g' package.json package-lock.json \
  packages/core/package.json packages/probe/package.json packages/sensors/package.json \
  packages/shared/package.json packages/simulators/package.json packages/web/package.json
git diff --numstat
# 16 16 package-lock.json, 3 3 core, 4 4 probe, 3 3 sensors, 2 2 web, 1 1 for the root, shared
# and simulators: 8 files, 31 31
git diff -U0 | grep '^[-+] ' | grep -v '1\.0\.0-rc\.[23]'    # prints nothing
git grep -n '"1\.0\.0-rc\.2"' -- package.json package-lock.json 'packages/*/package.json'    # nothing
```

The lock has to agree with the manifests: `npm ci` refuses one that does not. Then the two test
files that read the version and the lock:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut || exit 1
perl -e 'alarm 1560; exec @ARGV' ./scripts/dev.sh "timeout 1500 sh -c 'npm ci && cd packages/core && npx tsc -b && node --test dist/test/package-provenance.test.js dist/test/build-hygiene.test.js'"
git status --porcelain          # the 8 files and nothing else: npm ci did not rewrite the lock
git commit -qam 'Release: every package says 1.0.0-rc.3, and nothing else changes'
```

## 3. The tag

Annotated, on the version commit, by Roman or with his yes. The hash is read, never typed.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut || exit 1
commit="$(git rev-parse HEAD)"; base="$(git rev-parse HEAD~1)"
[ "$(git rev-parse origin/main)" = "${base}" ] || { echo "origin/main is not the parent"; exit 1; }
git tag -a v1.0.0-rc.3 -m "v1.0.0-rc.3: the v1 release candidate, Linux only, from main at ${base} plus its version commit ${commit}. Built with the v1 profile. Carries P-432's name gate, off by default (probe.nameResolver: system); the field test sets gate on every probe."
[ "$(git rev-parse 'v1.0.0-rc.3^{commit}')" = "${commit}" ] && echo "tag is ${commit}"
```

The tag stays local until step 7. **If anything fails before then**, fix it on `main`, then cut
again from step 0.3: the markers, the suite (0.4, in a fresh `rc3-suite`), the differential
(0.6) and S7 (0.7), all on the new commit, and then step 1, whose loop stops while `origin/main`
is not the commit 0.4 and 0.6 passed on. Again as rc.3 only if nothing built from this tag has
left the machine, and otherwise as rc.4. A failure that needs no change on `main`, such as a
`DeadlineExceeded` from BuildKit (step 5), is the same command run again, and changes no commit.
A pushed tag is never moved (rc.1 stands as a tag with no packages for that reason). Step 1
makes the branch `release/rc3` and the worktree `rc3-cut`, and git refuses to make either again,
so clear the first attempt before it: the tag, the three worktrees this page makes (their
`release/`, `build/` and logs go with them), and the branch. The files steps 0.4 and 0.6 wrote
stay: each names the commit it passed on, and step 1 compares them with `origin/main`.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem || exit 1
git tag -d v1.0.0-rc.3
for tree in rc3-suite rc3-cut rc3-amd64; do
  if [ -e ".claude/worktrees/${tree}" ]; then git worktree remove --force ".claude/worktrees/${tree}"; fi
done
git worktree prune
git branch -D release/rc3
git worktree list | grep -E 'rc3-(suite|cut|amd64)'; git branch --list release/rc3    # both print nothing
```

**If anything fails after step 7 has pushed**, step 8's x86_64 build or its smokes for instance,
the tag stays where it is, pushed, and so does the version commit on `main`. The fix lands on
`main`, and the next candidate is rc.4, cut from step 0 by a copy of this page made for it (every
`rc.3` read as `rc.4`, the version commit from `1.0.0-rc.3`); rc.3's record says what failed and
which of its packages, if any, may be used.

## 4. The arm64 build, and its provenance

One toolchain run builds both tarballs, the full one and the probe host's, from the clean
worktree at the tag. `MS_BUILD_COMMIT` is read from the tag on the host, since `git` inside the
container cannot see a worktree's repository (`H-11`); `MS_BUILD_DIRTY=0` is true only because
the guard before it found the tree clean.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut || exit 1
commit="$(git rev-parse 'v1.0.0-rc.3^{commit}')"
[ "$(git rev-parse HEAD)" = "${commit}" ] && [ -z "$(git status --porcelain)" ] || exit 1
perl -e 'alarm 2460; exec @ARGV' ./scripts/dev.sh "timeout 2400 sh -c 'MS_BUILD_COMMIT=${commit} MS_BUILD_DIRTY=0 ./scripts/package.sh && MS_BUILD_COMMIT=${commit} MS_BUILD_DIRTY=0 ./scripts/package.sh --probe-only'"
ls -l release/
```

Every manifest says the version, the tag's commit, clean, and the v1 profile, and the commit is
one git has:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && ARCH=aarch64 bash <<'EOF'
set -euo pipefail
commit="$(git rev-parse 'v1.0.0-rc.3^{commit}')"
for pair in ms:core ms:probe ms-probe:probe; do
  name="${pair%%:*}"; svc="${pair#*:}"
  tarball="release/${name}-1.0.0-rc.3-linux-${ARCH}.tar.gz"
  [ "$(tar -xzOf "${tarball}" "${name}-1.0.0-rc.3/VERSION")" = '1.0.0-rc.3' ]
  json="$(tar -xzOf "${tarball}" "${name}-1.0.0-rc.3/app/${svc}/build.json")"
  printf '%s\n' "${json}" | python3 -I -c '
import json, sys
m = json.load(sys.stdin)
want = {"version": "1.0.0-rc.3", "commit": sys.argv[1], "dirty": False, "profile": "v1"}
bad = {k: m.get(k) for k in want if m.get(k) != want[k]}
assert not bad and str(m.get("lock", "")).startswith("sha256:"), (bad, m.get("lock"))
' "${commit}"
  [ "$(git cat-file -t "${commit}")" = commit ]
  echo "ok: ${tarball} app/${svc}/build.json"
done
EOF
```

## 5. The arm64 smokes

The runbook's four, against these files, each bounded at 40 minutes, one at a time. Given a
tarball, the install and restore smokes do not build their own. `smoke-packages.sh` packages the
staged trees step 4 left (`build/ms-1.0.0-rc.3`, `build/ms-probe-1.0.0-rc.3`) into the `.deb` and
`.rpm`, full and probe, and refuses to pass a package whose `build.json` is not this checkout,
clean. **Those are the packages the record lists**: it rewrites them in `release/`, so take the
checksums after it (step 6).

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && perl -e 'alarm 2400; exec @ARGV' ./scripts/smoke-install.sh release/ms-1.0.0-rc.3-linux-aarch64.tar.gz
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && MS_SMOKE_DISTRO=ubuntu perl -e 'alarm 2400; exec @ARGV' ./scripts/smoke-install.sh release/ms-1.0.0-rc.3-linux-aarch64.tar.gz
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && perl -e 'alarm 2400; exec @ARGV' ./scripts/smoke-packages.sh
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && perl -e 'alarm 2400; exec @ARGV' ./scripts/smoke-restore.sh release/ms-1.0.0-rc.3-linux-aarch64.tar.gz
```

Write down each one's last line and its time. A `DeadlineExceeded` from BuildKit on a `FROM` line
is not the code: `docker pull` that base image and run the same command again.

The differential does not run again here. Its boxes load a worktree's build of the probe, not a
tarball, and the tag is step 0.6's commit plus a version commit that changes no source.

## 6. The packages, as the package managers read them

The tilde, in the names and in the metadata, and an order in which `1.0.0` upgrades rc.3 and
rc.3 upgrades rc.2; and the same `build.json` in every package as in the tarball. Neither tool is
on the Mac, so each runs in its distribution's container, reading `release/` only.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && DEB=arm64 RPM=aarch64 bash <<'EOF'
set -euo pipefail
ls release/ | sort
docker run --rm -e DEB -e RPM -v "$PWD/release:/r:ro" debian:bookworm bash -c '
  set -e
  for deb in "/r/ms_1.0.0~rc.3_${DEB}.deb" "/r/ms-probe_1.0.0~rc.3_${DEB}.deb"; do
    dpkg-deb -f "$deb" Package Version Architecture
    [ "$(dpkg-deb -f "$deb" Version)" = "1.0.0~rc.3" ]
    dpkg-deb --fsys-tarfile "$deb" | tar -xO ./opt/ms/app/probe/build.json; echo
  done
  dpkg --compare-versions 1.0.0~rc.3 lt 1.0.0 && dpkg --compare-versions 1.0.0~rc.2 lt 1.0.0~rc.3 \
    && echo "dpkg: rc.2 < rc.3 < 1.0.0"'
docker run --rm -e DEB -e RPM -v "$PWD/release:/r:ro" rockylinux:9 bash -c '
  set -e
  dnf install -y -q cpio >/dev/null 2>&1
  for rpm in "/r/ms-1.0.0~rc.3-1.${RPM}.rpm" "/r/ms-probe-1.0.0~rc.3-1.${RPM}.rpm"; do
    rpm -qp --qf "%{NAME} %{VERSION} %{RELEASE} %{ARCH}\n" "$rpm"
    [ "$(rpm -qp --qf "%{VERSION}" "$rpm")" = "1.0.0~rc.3" ]
    rpm2cpio "$rpm" | cpio -i --quiet --to-stdout ./opt/ms/app/probe/build.json; echo
  done
  [ "$(rpm --eval "%{lua: print(rpm.vercmp(\"1.0.0~rc.3\", \"1.0.0\"))}")" = "-1" ] \
    && [ "$(rpm --eval "%{lua: print(rpm.vercmp(\"1.0.0~rc.2\", \"1.0.0~rc.3\"))}")" = "-1" ] \
    && echo "rpm: rc.2 < rc.3 < 1.0.0"'
EOF
```

Each `build.json` printed must be byte for byte its own tarball's from step 4, `ms` with `ms`
and `ms-probe` with `ms-probe` (their `lock` differs: each stages what its own workspaces
reach). Then the record's table:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut/release && ARCH=aarch64 DEB=arm64 RPM=aarch64 bash <<'EOF'
for f in "ms-1.0.0-rc.3-linux-${ARCH}.tar.gz" "ms-probe-1.0.0-rc.3-linux-${ARCH}.tar.gz" \
  "ms_1.0.0~rc.3_${DEB}.deb" "ms-probe_1.0.0~rc.3_${DEB}.deb" \
  "ms-1.0.0~rc.3-1.${RPM}.rpm" "ms-probe-1.0.0~rc.3-1.${RPM}.rpm"; do
  printf '| `%s` | %s | `%s` |\n' "$f" "$(wc -c < "$f" | tr -d ' ')" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
done
EOF
```

These blocks run in bash, and every name with a `~` is quoted: in zsh with `extendedglob` set,
`~` is a pattern character.

## 7. Push the version commit and the tag

Only once steps 4 to 6 have passed on arm64. `origin/main` must not have moved since step 1:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && git fetch -q origin
[ "$(git rev-parse origin/main)" = "$(git rev-parse 'v1.0.0-rc.3^{commit}~1')" ] \
  && git push origin HEAD:main v1.0.0-rc.3
```

If it moved, stop: the version commit's parent is no longer the head of `main`, and rebasing it
would make the tag's commit one no suite ran on. Ask before doing anything else.

## 8. The x86_64 build and smokes (`H-14`'s way)

The field host is almost certainly x86_64. Built under emulation on this machine, from **a second
clean worktree at the tag** (an amd64 `npm ci` replaces `node_modules` with x86_64 addons, which
must not land in the arm64 worktree), and in **its own compose project**, so that the amd64
toolchain image does not replace the arm64 one every other session's `dev.sh` runs. **Every
command in this step carries both settings**, `DOCKER_DEFAULT_PLATFORM=linux/amd64` and
`COMPOSE_PROJECT_NAME=ms-amd64`: one without them builds or boots arm64, or rebuilds the shared
image. Its toolchain runs are named `ms-amd64-toolchain-run-…`, which step 0.5's count includes.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem
git worktree add --detach /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 v1.0.0-rc.3
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 || exit 1
commit="$(git rev-parse 'v1.0.0-rc.3^{commit}')"
[ "$(git rev-parse HEAD)" = "${commit}" ] && [ -z "$(git status --porcelain)" ] || exit 1
DOCKER_DEFAULT_PLATFORM=linux/amd64 COMPOSE_PROJECT_NAME=ms-amd64 perl -e 'alarm 5460; exec @ARGV' ./scripts/dev.sh "timeout 5400 sh -c 'uname -m && npm ci && MS_BUILD_COMMIT=${commit} MS_BUILD_DIRTY=0 ./scripts/package.sh && MS_BUILD_COMMIT=${commit} MS_BUILD_DIRTY=0 ./scripts/package.sh --probe-only'"
```

`uname -m` must print `x86_64`. Then step 4's provenance block from this worktree with
`ARCH=x86_64`, and two more checks: the manifest is the arm64 one byte for byte, and every native
addon that loads on an x86_64 Linux host is x86-64 Linux code. **Not every `.node` in the
tarball**: `argon2` ships a prebuild for every platform it supports under `prebuilds/` (linux-arm,
linux-arm64, darwin-arm64, freebsd, win32 and linux-x64, musl and glibc), `package.sh` keeps them
all, and only `prebuilds/linux-x64/*.glibc.node` is read on the field host. rc.2's tarball has
the same set, so a check of every file fails on a correct build. What loads is what `npm ci`
compiled (`build/Release`: `cpu-features` and `ssh2`'s crypto in rc.2), which must be the same
addons the arm64 build compiled, and that one prebuild, which must be there. Both tarballs, the
full one and the probe host's:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 && bash <<'EOF'
set -euo pipefail
arm_release=/Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut/release
cmp <(tar -xzOf "${arm_release}/ms-1.0.0-rc.3-linux-aarch64.tar.gz" ms-1.0.0-rc.3/app/core/build.json) \
  <(tar -xzOf release/ms-1.0.0-rc.3-linux-x86_64.tar.gz ms-1.0.0-rc.3/app/core/build.json)
scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
compiled() { tar -tzf "$1" | grep -E '/build/Release/.*[.]node$' | sort || true; }
for name in ms ms-probe; do
  arm="${arm_release}/${name}-1.0.0-rc.3-linux-aarch64.tar.gz"
  x86="release/${name}-1.0.0-rc.3-linux-x86_64.tar.gz"
  cmp <(compiled "$arm") <(compiled "$x86") \
    || { echo "${name}: npm ci compiled other addons on x86_64 than on arm64"; exit 1; }
  mkdir "$scratch/$name"; tar -xzf "$x86" -C "$scratch/$name"
  addons="$(find "$scratch/$name" -name '*.node' \( -path '*/build/Release/*' -o -path '*/prebuilds/linux-x64/*.glibc.node' \) -exec file {} + | sed "s|^$scratch/$name/||")"
  printf '%s\n' "$addons"
  bad="$(grep -v 'ELF 64-bit LSB .*x86-64' <<<"$addons" || true)"
  [ -z "$bad" ] || { echo "${name}: an addon that loads on x86_64 is not x86-64 ELF:"; printf '%s\n' "$bad"; exit 1; }
done
[ -f "$scratch/ms/ms-1.0.0-rc.3/app/node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node" ] \
  || { echo "argon2's linux-x64 glibc prebuild is not in the tarball"; exit 1; }
echo "x86_64 manifest and addons ok"
EOF
```

The smokes, the same way, except Ubuntu: Docker Desktop's Rosetta kills every unit Ubuntu
24.04's systemd starts through `systemd-executor`, so that box cannot boot here and says nothing
about the package (`H-29`). Record it as not run.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 && DOCKER_DEFAULT_PLATFORM=linux/amd64 COMPOSE_PROJECT_NAME=ms-amd64 perl -e 'alarm 3600; exec @ARGV' ./scripts/smoke-packages.sh
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 && DOCKER_DEFAULT_PLATFORM=linux/amd64 COMPOSE_PROJECT_NAME=ms-amd64 perl -e 'alarm 3600; exec @ARGV' ./scripts/smoke-install.sh release/ms-1.0.0-rc.3-linux-x86_64.tar.gz
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 && DOCKER_DEFAULT_PLATFORM=linux/amd64 COMPOSE_PROJECT_NAME=ms-amd64 perl -e 'alarm 3600; exec @ARGV' ./scripts/smoke-restore.sh release/ms-1.0.0-rc.3-linux-x86_64.tar.gz
```

Then step 6's two blocks from this worktree, with `DOCKER_DEFAULT_PLATFORM=linux/amd64` before
`bash` and `ARCH=x86_64 DEB=amd64 RPM=x86_64`, so the containers that read the packages are
amd64 too.

**Put the machine back**, with neither setting. The smokes tag their boxes' images `ms-smoke:*`
whatever the platform, and the amd64 base images were pulled under the same names:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut || exit 1
for image in debian:bookworm ubuntu:24.04 rockylinux:9; do docker pull -q --platform linux/arm64 "$image"; done
docker build -q --platform linux/arm64 -t ms-smoke:bookworm -f scripts/smoke/Dockerfile scripts/smoke
docker build -q --platform linux/arm64 -t ms-smoke:ubuntu -f scripts/smoke/Dockerfile.ubuntu scripts/smoke
docker build -q --platform linux/arm64 -t ms-smoke:rocky -f scripts/smoke/Dockerfile.rocky scripts/smoke
docker ps -a --filter label=ms-smoke --format '{{.Names}}'    # none of this cut's boxes is left
```

## 9. The record, and the documents that point at it

In a docs commit on `main`, after the tag (the tagged tree's documents keep their placeholders,
as rc.2's did):

1. **`docs/findings/<cut date>-v1-release-candidate-rc3-cut.md`**, in the shape of
   [rc.2's](2026-10-04-v1-release-candidate-cut.md): the tag and both commits; the manifest; the
   two checksum tables (arm64, x86_64), the probe's packages included; the smokes with their
   times, and Ubuntu on x86_64 as not run (`H-29`); the suite's line (step 0.4); the
   differential's run, with step 0.6.1's lines, the recordings it verified and the build it
   judged (step 0.6); S7's two runs with their conditions (step 0.7); and what is not yet true
   of it.
2. **`docs/runbook-field-test.md`**: the four *Last verified* rows, `2026-10-<dd>, v1.0.0-rc.3,
   locally (arm64; x86_64 except Ubuntu)`; and step 1's pointer to the record whose checksums a
   package is checked against.
3. **`docs/release-notes-1.0.md`**: the *Verified* line (the commit, the date, the record), which
   keeps saying that Ubuntu on x86_64 was not run (`H-29`) unless it was, and *What a candidate
   has been installed on* under *Requirements*; and *Name resolution*'s **Before `v1.0.0`**
   gains the gate's measurement, from step 0.7's run and S7's findings.
4. **`docs/README.md`**: the row *Know what the current candidate is and what was checked* names
   rc.3's record.
5. **`docs/TASKS.md`**: `H-50` is ticked with the record, `P-432`'s outcome names the cut, and
   `H-29` stays open unless an x86_64 Ubuntu install has run.
6. **`docs/findings/2026-10-20-name-lookups-gated.md`**: its Results, every `TODO(quiet-window)`,
   from step 0.7's two runs, with their conditions and the commit they ran on.

Then the worktrees go (`git worktree remove --force` on each of the two, after both `release/`
directories have been copied to where the field test will fetch them from; `--force` because
`node_modules`, `build/` and `release/` are ignored files git would otherwise refuse to remove), and the field test can
start (`H-09`).
