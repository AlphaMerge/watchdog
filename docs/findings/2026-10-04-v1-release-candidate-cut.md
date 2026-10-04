# The v1 release candidate, as cut — 2026-10-04

- **What this is**: the record step 6 of the cut asks for
  (`docs/findings/2026-09-28-v1-release-candidate.md` §4): the tag, the commit, the package
  checksums and the four smoke results, written before the field test starts so its write-up
  begins with what was installed.
- **The candidate**: **`v1.0.0-rc.2`**, an annotated tag on `0a43b7bfbb705253e883050223790c9e271cf67a`
  — `main` at `7960f035` plus one commit that changes every `package.json`, the internal `@ms/*`
  pins and the lockfile to `1.0.0-rc.2`, and nothing else. Cut on Roman's word.
- **Not yet true of it**: `H-14` (an x86_64 build, proven once) and `H-15` (the dress rehearsal)
  are open. Everything below was built and installed on this project's Apple Silicon machine, so
  every package is `arm64`/`aarch64`; the field host will almost certainly be x86_64.

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

- `H-14`: build these three on x86_64 (under emulation or on an x86_64 machine), install them in
  the smoke containers the same way, and add their checksums here — or re-cut as rc.3 if
  anything has to change.
- `H-15`: the dress rehearsal of the runbook.
- A pass after the week is tagged `v1.0.0` on the same commit as the candidate that passed.
