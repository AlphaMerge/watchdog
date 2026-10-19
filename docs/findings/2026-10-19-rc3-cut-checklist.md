# Cutting `v1.0.0-rc.3` — the checklist, 2026-10-19

- **What this is**: the procedure the rc.2 cut followed
  ([its record](2026-10-04-v1-release-candidate-cut.md), from
  [the proposal's §4](2026-09-28-v1-release-candidate.md)), with every command written out, so that
  the cut is run from this page and not from memory. **Nothing here has been run yet.** It was
  written before `P-432`'s S3, S6 and S8 landed, and brought onto them on 2026-10-20 (`H-50`,
  on `a95c3302`, where they were integrated): every `TODO(rc3-cut)` marker the documents carried
  for them is resolved against that code. What is still to land before the cut, S7 and the
  tickets the coordinator put in 1.0, step 0.1 checks by name, and the cut does not start without
  them. What only the cut can say (the commit, the dates, the checksums) stays a `<…>`
  placeholder, filled in step 9.
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
   (`2026-10-20-name-lookups-gated.md` in `docs/findings/`); and the four things the coordinator
   put in 1.0 before this cut on 2026-10-20 (`P-432`'s outcome in `TASKS.md`): `P-453` (a child
   killed from outside poisons no name), `P-460` (the differential records the check's questions
   too), `P-461` (boxes that show the check off), and S6's re-check gaps (no avoided name started
   from the probe's queues, or settled after `stop()`). `P-454` stays open: it is a known limit
   in the release notes.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem
   git fetch -q origin
   git log --oneline origin/main | grep -E 'P-432 S[0-9]'    # S1 to S8, each at least once
   git cat-file -e origin/main:docs/findings/2026-10-20-name-lookups-gated.md && echo "S7's findings"
   git show origin/main:docs/TASKS.md | grep -cE '^- \[x\] \*\*(P-453|P-460|P-461) '    # 3
   ```

   The S6 gaps have no ticket of their own: read `P-432`'s outcome for the commit that closed
   them, and name it in the record.

2. **The differential's recordings are committed** (the user's decision of 2026-10-18: against
   `getaddrinfo`, `systemd-resolved` included). `P-432` S8 ran it in boxes of each
   distribution's own image rather than the smoke images, since the glibc and the NSS modules are
   the distribution's either way (S8's outcome, decided 2026-10-20): Rocky 8 and 9, Debian 11, 12
   and 13, Ubuntu 22.04 and 24.04. The fixture holds glibc's wire for every image, and Ubuntu
   24.04's run went through `systemd-resolved`:

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
   git show origin/main:packages/probe/test/fixtures/system-names-recordings.json | python3 -I -c '
   import json, sys
   r = json.load(sys.stdin)
   images = r["images"]
   print(sorted(images), "recordings:", len(r["recordings"]))
   assert sorted(images) == ["debian11", "debian12", "debian13", "rocky8", "rocky9", "ubuntu2204", "ubuntu2404"], images
   assert images["ubuntu2404"]["resolved"] is True
   '
   ```

   Step 0.6 runs it again, on the commit to be cut.

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
   git worktree add --detach /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite origin/main || exit 1
   cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite || exit 1
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ -z "$(git status --porcelain)" ] || exit 1
   git rev-parse HEAD              # the commit this run passes or fails, for step 1
   perl -e 'alarm 1260; exec @ARGV' ./scripts/dev.sh "timeout 1200 npm ci"
   MS_TEST_TIMEOUT=3600 perl -e 'alarm 7500; exec @ARGV' ./scripts/test-all.sh
   ```

   The last line must be `==> clean. Full log: …`. Write down its `tests · pass · fail ·
   cancelled · skipped` line and every `﹣` line it lists, and compare them with the last green
   run's: `skipped 0`, `cancelled 0` and `fail 0`, and a `tests` total that fell names suites that
   did not run. `clean, but N suite(s) never ran` is not a pass. Keep the worktree for steps 0.6
   and 0.7, and remove it after them (`git worktree remove --force` on it, from the main
   checkout). Nothing else lands from here until step 7 has pushed: the version commit's parent
   must be the commit that passed, which step 1 checks.
5. **The VM has room.** Builds and smokes are heavy: start one only when fewer than two toolchain
   runs are going, counting the amd64 project's too, and run the smokes one at a time.

   ```bash
   docker ps -q --filter name=toolchain-run | wc -l | tr -d ' '    # under 2
   ```

6. **The name gate's differential passes on the commit to be cut, in all seven images**
   (`scripts/smoke/name-gate-differential.sh`), in step 0.4's worktree. It judges which
   questions glibc sends, never how long anything takes, so it needs step 0.5's count under 2,
   not a quiet machine. Every image, with no `MS_DIFF_IMAGES` or `MS_DIFF_ONLY` (a narrowed run
   never verifies), on the digests the recordings were made on (no `MS_DIFF_REFRESH`), and
   without `MS_DIFF_WRITE`: the cut checks the committed recordings, it does not rewrite them.
   The boxes load the worktree's build, and the script refuses one older than its sources, so
   build first. S8's run 3 took 830 s; each image's replay is bounded at 1,500 s inside its box.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite || exit 1
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ -z "$(git status --porcelain)" ] || exit 1
   perl -e 'alarm 660; exec @ARGV' ./scripts/dev.sh "timeout 600 npx tsc -b packages/probe"
   mkdir -p /tmp/rc3-diff
   MS_DIFF_OUT=/tmp/rc3-diff perl -e 'alarm 3600; exec @ARGV' ./scripts/smoke/name-gate-differential.sh 2>&1 | tee /tmp/rc3-diff/run.out
   ```

   It must end `==> NAME GATE DIFFERENTIAL PASSED (runs in /tmp/rc3-diff)`, with a `rows in …`
   line for each of the seven images and `systemd-resolved: active` for `ubuntu2404`. Any
   `FAILED` line, or `MS_DIFF_REFRESH` named because a recorded digest could no longer be pulled,
   stops the cut: a moved image is a new recording, made on `main` and reviewed, not at the cut.
   `git status --porcelain` in the worktree prints nothing afterwards.

   1. **`P-460`'s walk recording, as a step of its own.** With `P-460` landed, the same run also
      records the name check's own questions for every row and plan, from `DnsCheck.route` with
      no lanes and no helper, and fails where they differ from glibc's: the qnames, qtypes and
      servers in order up to where each stops, and heard if and only if glibc returned within
      1 s, with `P-460`'s regression, budget and answer rows. `P-460`'s outcome in `TASKS.md`
      names the line its run prints for that recording: find that line in `run.out`, and name
      both recordings in the record. A run that passes without it has not tested the check, and
      the cut waits.

   Copy `/tmp/rc3-diff` beside the record before the worktree goes.

7. **S7's full-size name-lookups run, on the commit to be cut**, in step 0.4's worktree: the
   gate's `test:perf` arms, cold and warm, in both modes beside `P-426`'s, whose findings file is
   `2026-10-20-name-lookups-gated.md` in `docs/findings/`. **A quiet window**: `ms-server`
   stopped, no other toolchain run, and the other projects' containers paused only with the
   user's leave, asked each time. The conditions print at the top of the run (`P-192`), and go in
   the record with the numbers. The command is the one that findings file says it ran, at full
   size; the design's knobs (`p432-r2-final.md` §7.6) are below, and where S7's file differs, its
   line is the one to run:

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-suite || exit 1
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || exit 1
   docker ps -q --filter name=toolchain-run | wc -l | tr -d ' '    # 0
   perl -e 'alarm 660; exec @ARGV' ./scripts/dev.sh "timeout 600 npx tsc -b"
   perl -e 'alarm 7260; exec @ARGV' ./scripts/dev.sh "timeout 7200 sh -c 'sleep 180; node scripts/perf-conditions.mjs; MS_DNS_RESOLVER=system,gate MS_DNS_WARM_MINUTES=7 MS_DNS_COLD_MINUTES=7 node --test --test-concurrency=1 packages/probe/dist/test/perf/name-lookups.test.js'" 2>&1 | tee /tmp/rc3-diff/name-lookups.out
   ```

   Every arm passes (`fail 0`, `cancelled 0`), and each number the findings file records is read
   against this run's: a result on the other side of a bound the findings state, or of the
   design's verdict for `gate` as the field test's setting (§9: the memory arms, the event
   loop's p99), stops the cut. Then `ms-server` is started and verified, and the paused
   containers unpaused.

## 1. The commit, and a clean worktree for it

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
git rev-parse origin/main       # the commit the suite passed on, or stop
git worktree add -b release/rc3 /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut origin/main || exit 1
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && git status --porcelain    # prints nothing
```

A second attempt stops at `worktree add`, which refuses while the first attempt's branch or
worktree is there: clear them with step 3's block, then run this again.

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

The tag stays local until step 7. **If anything fails before then**, fix on `main` and cut again
from step 1: as rc.3 again only if nothing built from this tag has left the machine, and
otherwise as rc.4. A pushed tag is never moved (rc.1 stands as a tag with no packages for that
reason). Step 1 makes the branch `release/rc3` and the worktree `rc3-cut`, and git refuses to make
either again, so clear the first attempt before it: the tag, both worktrees this page makes (their
`release/` and `build/` go with them), and the branch.

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem || exit 1
git tag -d v1.0.0-rc.3
for tree in rc3-cut rc3-amd64; do
  if [ -e ".claude/worktrees/${tree}" ]; then git worktree remove --force ".claude/worktrees/${tree}"; fi
done
git worktree prune
git branch -D release/rc3
git worktree list | grep -E 'rc3-(cut|amd64)'; git branch --list release/rc3    # both print nothing
```

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
   differential's run, both recordings named (step 0.6); S7's run with its conditions (step
   0.7); and what is not yet true of it.
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

Then the worktrees go (`git worktree remove --force` on each of the two, after both `release/`
directories have been copied to where the field test will fetch them from; `--force` because
`node_modules`, `build/` and `release/` are ignored files git would otherwise refuse to remove), and the field test can
start (`H-09`).
