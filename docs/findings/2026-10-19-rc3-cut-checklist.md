# Cutting `v1.0.0-rc.3` — the checklist, 2026-10-19

- **What this is**: the procedure the rc.2 cut followed
  ([its record](2026-10-04-v1-release-candidate-cut.md), from
  [the proposal's §4](2026-09-28-v1-release-candidate.md)), with every command written out, so that
  the cut is run from this page and not from memory. **Nothing here has been run yet.** It was
  written before `P-432`'s last slices landed, so the steps that depend on them carry a
  `TODO(rc3-cut)` marker, and the cut does not start while one is left (step 0).
- **What it adds to rc.2's procedure**: the x86_64 build and its smokes as steps, not a ticket
  (`H-14`); the probe host's packages in the record, since the field test now installs remote
  probes (runbook step 1); `P-432`'s differential as a gate, by the user's decision of 2026-10-18;
  and a check, at each artefact, of the three things rc.1 got wrong (below).
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

1. **`P-432` has landed whole**: S1 to S8 on `origin/main`.

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem
   git fetch -q origin
   git log --oneline origin/main | grep -E 'P-432 S[0-9]'
   ```

2. **Its differential has passed, with its recordings committed** (the user's decision of
   2026-10-18: against `getaddrinfo`, in the smoke images, `systemd-resolved` included). The
   recordings file S4 left empty for S8 must now hold every image's:

   ```bash
   git show origin/main:packages/probe/test/fixtures/system-names-recordings.json | head -c 400
   ```

   <!-- TODO(rc3-cut): S8 had not landed when this was written. Put the differential's exact
   command here (design p432-r2-final.md §7.5 names scripts/smoke/name-gate-differential.sh),
   with its bound, and the line its passing run prints. -->

3. **No `TODO(rc3-cut)` marker is left in the documents** that ship in `/opt/ms/docs`. Each is
   resolved against the landed code in a docs commit on `main`, before step 2; the version
   commit changes nothing but versions. This page's own markers go with them. The pattern is
   written so that it does not find itself:

   ```bash
   cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
   git grep -nE '<!-- TODO[(]rc3-cut[)]' origin/main -- docs    # prints nothing
   ```

4. **The full suite is green on the commit to be cut**, by `scripts/test-all.sh` (it fails on
   `cancelled` and prints `﹣` lines for skipped suites, which a bare summary hides: compare the
   totals with the last green run, `skipped 0` included). Nothing else lands from here until step
   7 has pushed: the version commit's parent must be the commit that passed.
5. **The VM has room.** Builds and smokes are heavy: start one only when fewer than two toolchain
   runs are going, counting the amd64 project's too, and run the smokes one at a time.

   ```bash
   docker ps -q --filter name=toolchain-run | wc -l | tr -d ' '    # under 2
   ```

## 1. The commit, and a clean worktree for it

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem && git fetch -q origin
git rev-parse origin/main       # the commit the suite passed on, or stop
git worktree add -b release/rc3 /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut origin/main
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut && git status --porcelain    # prints nothing
```

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

The tag stays local until step 7. **If anything fails before then**, delete it
(`git tag -d v1.0.0-rc.3`) and `release/`, fix on `main`, and cut again from step 1: as rc.3 again
only if nothing built from this tag has left the machine, and otherwise as rc.4. A pushed tag is
never moved (rc.1 stands as a tag with no packages for that reason).

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

<!-- TODO(rc3-cut): if S8's differential is meant to run against the candidate as well as on
main (step 0.2), its command goes here, against this worktree. -->

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
addon is x86-64:

```bash
cd /Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-amd64 && bash <<'EOF'
set -euo pipefail
arm=/Users/admin/Desktop/Projects/MonitoringSystem/.claude/worktrees/rc3-cut/release/ms-1.0.0-rc.3-linux-aarch64.tar.gz
x86=release/ms-1.0.0-rc.3-linux-x86_64.tar.gz
cmp <(tar -xzOf "$arm" ms-1.0.0-rc.3/app/core/build.json) <(tar -xzOf "$x86" ms-1.0.0-rc.3/app/core/build.json)
scratch="$(mktemp -d)"; tar -xzf "$x86" -C "$scratch"
addons="$(find "$scratch" -name '*.node' -exec file {} +)"; rm -rf "$scratch"
printf '%s\n' "$addons"
[ -n "$addons" ] || { echo "no native addon found: the check would pass on nothing"; exit 1; }
if grep -qv 'x86-64' <<<"$addons"; then echo "an addon is not x86-64"; exit 1; fi
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
   times, and Ubuntu on x86_64 as not run (`H-29`); the differential's run; and what is not yet
   true of it.
2. **`docs/runbook-field-test.md`**: the four *Last verified* rows, `2026-10-<dd>, v1.0.0-rc.3,
   locally (arm64; x86_64 except Ubuntu)`; and step 1's pointer to the record whose checksums a
   package is checked against.
3. **`docs/release-notes-1.0.md`**: the *Verified* line (the commit, the date, the record), and
   *What a candidate has been installed on* under *Requirements*.
4. **`docs/README.md`**: the row *Know what the current candidate is and what was checked* names
   rc.3's record.
5. **`docs/TASKS.md`**: `H-50` is ticked with the record, `P-432`'s outcome names the cut, and
   `H-29` stays open unless an x86_64 Ubuntu install has run.

Then the worktrees go (`git worktree remove --force` on each of the two, after both `release/`
directories have been copied to where the field test will fetch them from; `--force` because
`node_modules`, `build/` and `release/` are ignored files git would otherwise refuse to remove), and the field test can
start (`H-09`).
