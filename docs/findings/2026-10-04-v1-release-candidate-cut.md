# The v1 release candidate, as cut — 2026-10-04

- **What this is**: the record step 6 of the cut asks for
  (`docs/findings/2026-09-28-v1-release-candidate.md` §4): the tag, the commit, the package
  checksums and the four smoke results, written before the field test starts so its write-up
  begins with what was installed.
- **The candidate**: **`v1.0.0-rc.2`**, an annotated tag on `0a43b7bfbb705253e883050223790c9e271cf67a`
  — `main` at `7960f035` plus one commit that changes every `package.json`, the internal `@ms/*`
  pins and the lockfile to `1.0.0-rc.2`, and nothing else. Cut on Roman's word.
- **Not yet true of it**: `H-15` (the dress rehearsal) is open. Everything was built and
  installed on this project's Apple Silicon machine: the first set of packages natively
  (`arm64`/`aarch64`), and the x86_64 set the field host will almost certainly need under
  emulation (`H-14`, below).

## The packages

Built from the tagged commit on a clean tree, with the v1 profile, inside the toolchain container
(`MS_BUILD_COMMIT` read from `git rev-parse` on the host, since git inside the container cannot
see a worktree's repository). Every package's `app/*/build.json` reads:

```json
{
  "version": "1.0.0-rc.2",
  "commit": "0a43b7bfbb705253e883050223790c9e271cf67a",
  "dirty": false,
  "profile": "v1",
  "lock": "sha256:571a99105d98701c689ea33d7626beadf01ce1500bca17938290a0ac2ef4bf45"
}
```

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `ms-1.0.0-rc.2-linux-aarch64.tar.gz` | 32,018,889 | `5ad496f26edaa7827740339a28a47709e0310ae88e00df231313e4438b4e1aae` |
| `ms_1.0.0~rc.2_arm64.deb` | 17,084,236 | `e1f8123a4e81aa472842cee27050c27e14bb38afbad4012c8cf8d4a4ea60ac74` |
| `ms-1.0.0~rc.2-1.aarch64.rpm` | 19,794,815 | `478830b1dee8962dc0b57f14dc3a21df3c7cf1b4d6e1c16a7d448261aa0fc119` |

The packages spell the version `1.0.0~rc.2` so that `1.0.0` sorts after the candidate and
upgrades it (`7960f035`); the tarball and `/opt/ms/VERSION` keep the tag's spelling.

## The four smoke tests, against these packages

All run locally on 2026-10-04, one after another, each bounded at 40 minutes.

| Test | Command | Result |
| --- | --- | --- |
| Clean install on Debian | `scripts/smoke-install.sh <tarball>` | passed, 2 min 33 s |
| Clean install on Ubuntu | `MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh <tarball>` | passed, 2 min 33 s |
| `.deb` and `.rpm` install, upgrade, remove | `scripts/smoke-packages.sh` | passed (deb and rpm), 2 min 11 s |
| Backup and restore onto a different host | `scripts/smoke-restore.sh <tarball>` | passed, 43 s |

The runbook's "Last verified" table carries these dates.

## The x86_64 packages (`H-14`)

Built from the same tag on a clean worktree, under `linux/amd64` emulation on the same machine:
the toolchain image rebuilt for amd64 ran `package.sh`, so `npm ci` fetched x86_64 native addons
and compiled the rest there, and `package-deb.sh` / `package-rpm.sh` re-execed in amd64 Debian
and Rocky containers. The manifest is the one above, byte for byte; `argon2`'s `linux-x64`
prebuild is the one shipped, and `ssh2`'s `sshcrypto.node` and `cpu-features`' `cpufeatures.node`
are ELF x86-64.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `ms-1.0.0-rc.2-linux-x86_64.tar.gz` | 32,032,518 | `0d551903ea41e8a9b66db89f5a8bfad087e1ec9be67bbf00f33b3e76aec6e6f1` |
| `ms_1.0.0~rc.2_amd64.deb` | 17,090,492 | `25f66702af4f7e7f008b056d90be980a4333a7f1323e138d3e7c31d4032e5258` |
| `ms-1.0.0~rc.2-1.x86_64.rpm` | 19,801,619 | `9d9d21db04622437ba41798e58c5da1d46c05d35e7d870cf7fe184973cb4ba6a` |

The same four smoke tests, run with `DOCKER_DEFAULT_PLATFORM=linux/amd64` so every container,
the installed services included, ran x86_64 code under emulation:

| Test | Result |
| --- | --- |
| `.deb` and `.rpm` install, upgrade, remove | passed (deb and rpm), 7 min 34 s |
| Clean install on Debian | passed, 3 min 42 s |
| Clean install on Ubuntu | **could not run here** — see below |
| Backup and restore onto a different host | passed, 1 min 31 s |

**Ubuntu 24.04 cannot boot under this emulator, and that says nothing about the package.** Docker
Desktop emulates x86_64 with Rosetta. Ubuntu 24.04's systemd 255 starts every service through
its new `systemd-executor`, and under Rosetta every unit started that way dies with
`255/EXCEPTION` — `systemd-tmpfiles-setup` and `journald` as well as PostgreSQL, whose socket
directory is then never made, so the run stops at the operator's prerequisite before anything of
ours is installed. The same `systemd-tmpfiles` run by hand in the same box succeeds. Debian
12's systemd 252 has no executor, which is why its box booted and passed. Run twice, failed the
same way twice. The x86_64 Ubuntu install is therefore still unproven by a smoke test; the field
host, or an x86_64 machine, or Docker switched to QEMU emulation, is where it gets proven, and
the arm64 Ubuntu run above is the closest evidence until then.

Emulation is slower than the field host will be, by a factor this does not measure, and every
timing check in the three tests that ran still held under it — the probe's watchdog test
included.

## Why there is an rc.1 that is not the candidate

`v1.0.0-rc.1` was tagged first, on `48ee0be9` (`main` at `9e8a644b` plus its version commit). Its
tarball was correct, and the Debian, Ubuntu and restore smoke tests passed against it. Its
packages could not be made right from that tag:

- `rpmbuild` refuses `Version: 1.0.0-rc.1`, since rpm allows no `-` in a version.
- `dpkg` reads everything after the last `-` as a packaging revision. `dpkg --compare-versions`
  says `1.0.0-rc.1` is *not* less than `1.0.0`, so the release would have been refused as a
  downgrade of its own candidate.

The fix (`7960f035`) gives the package manager `1.0.0~rc.1`. Built with it from rc.1's staged
tree, the packages were correct, but `smoke-packages.sh` then failed exactly as it should: the
installed package said it was `48ee0be9`, clean, and the checkout running the test was not. So
rc.1 stands as a tag with a correct tarball and no packages, and the candidate was re-cut as rc.2,
whose tag, tarball and packages come from one commit.

One more slip, caught before anything was published: the first rc.1 tarball was built with a
commit hash typed from memory, and its manifest named a commit that does not exist. It was
deleted and rebuilt with the hash read from git. Read the hash; never type it.

## Before the field test

- `H-15`: the dress rehearsal of the runbook.
- `H-29`: the x86_64 `.deb` on Ubuntu, which this machine's emulator cannot boot. The field
  test's step 1 proves it on the field host if nothing proves it sooner.
- A pass after the week is tagged `v1.0.0` on the same commit as the candidate that passed.
