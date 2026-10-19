# The name gate's policy against glibc, in seven images (`P-432` S8)

2026-10-20, on `feat/p432-s8-diff` (on `f762dfc6`). `scripts/smoke/name-gate-differential.sh`,
the whole run three times: first on S4's policy as it landed, then on the policy narrowed by what
the first run found, and then after the review's fixes (run 3). Built first, then:

```
MS_DIFF_WRITE=1 ./scripts/smoke/name-gate-differential.sh
```

**What it does.** Every row S4 exports (`packages/probe/test/fixtures/system-names-rows.json`) is
replayed in a box of each image, against that image's own `getaddrinfo`, with the S5 DNS
simulator as every server the row's resolv.conf names (and as 127.0.0.1 and ::1, to catch a
question sent where no server was named). For each row the policy is loaded in the box against
the row's real files and classifies the question; for each plan glibc is asked once, in a process
of its own, through `systemLookup`. A row agrees when the policy in the box reads the question as
the row says, and glibc's questions are the plan's wire exactly: server, name, type and try, in
order, and none at all for a `local` name.

**Conditions.** Not a quiet run, and it does not need to be: it judges which questions glibc
sends, never how long anything takes. The VM gate was below 2 toolchain runs at the start of
each; other sessions' runs came and went beside it. `ms-server` was running.

**The boxes** (`scripts/smoke/Dockerfile.names`, arm64), each from the distribution's base image:

| Image | Base | glibc | Notes |
| --- | --- | --- | --- |
| `rocky8` | `rockylinux:8` | 2.28 | |
| `debian11` | `debian:bullseye` | 2.31 | packages from the base image's snapshot |
| `rocky9` | `rockylinux:9` | 2.34 | the `.rpm` smoke image's base |
| `ubuntu2204` | `ubuntu:22.04` | 2.35 | |
| `debian12` | `debian:bookworm` | 2.36 | the smoke image's base |
| `ubuntu2404` | `ubuntu:24.04` | 2.39 | the smoke image's base; boots systemd, systemd 255 with **systemd-resolved** active |
| `debian13` | `debian:trixie` | 2.41 | |

## Run 1: S4's policy as it landed

267 rows in each image, 2,998 plans in all (427 per image, 436 on Rocky 8), each image's rows in
85–100 s and the whole run in 825 s. **2,938 plans agreed and 60 did not**, in two shapes. Both
are the same kind of error: the policy walked a name that glibc answered without asking DNS.
That costs the gate a walk it did not need. It never puts a lookup that can block on a probe lane.

1. **The hostname, asked for family 6, under `files myhostname dns`** (3 rows, both plans, every
   image: 42). The policy walked `probe-1`, `probe-1.` and the dotted `probe-1.lab.example` for
   AAAA. In every image nss-myhostname answered them, and glibc asked no DNS. The policy's own
   comment said it "does not pin" this case: on a host without IPv6, newer systemd answers
   NOTFOUND and glibc goes on to DNS. The boxes have IPv6 on `lo`. Families 0 and 4 agreed
   everywhere.
2. **A name beginning with `-` on Rocky 8** (9 rows, both plans: 18). The policy walks such a name
   below 2.29, as upstream 2.28 asks it (BZ 24112's `check_name` came in 2.29). Rocky 8's 2.28
   carries the fix: glibc refused all nine unasked, `ENOTFOUND` in under 10 ms.

Everything else agreed in every image: the hosts file, with the `::1` and `::ffff:` lines for
family 4; the `inet_aton` forms; the search walk under every `ndots`; `search .`; the hostname's
domain; a long search list; the first three servers and never a fourth; IPv6 servers, a
v4-mapped one included; SERVFAIL, REFUSED and silence each moving to the next server; `rotate`
with two and three servers, from whichever server glibc started at; `timeout` and `attempts`
caps; and both stub rows through systemd-resolved.

## The fix

Both cases are now not vouched for (`cannotVouch`), so they take the unvouched route to the
lookup helper, which is safe whatever glibc does:
- `hostname-family-6`: the hostname, or it with a trailing dot, for family 6 under
  `files myhostname dns`. Whether nss-myhostname answers depends on the host's IPv6 and on
  systemd's version, and the policy reads neither.
- `leading-dash`: a name beginning with `-` below 2.29. A distribution's 2.28 may refuse it, as
  Rocky 8's does.

S4's export drops the 3 hostname rows (264 rows), and leaves the 9 `-dash` rows out of Rocky 8.

## Run 2: the narrowed policy

**It passed.** 264 rows in each image (255 on Rocky 8, which leaves the 9 `-dash` rows out),
2,938 plans, **every one agreeing**, each image's rows in 95–137 s and the whole run in 793 s.
`packages/probe/test/fixtures/system-names-recordings.json` holds the 2,938 recordings, with
each image's base, digest, glibc and Node, and `system-names.test` now fails any exported row,
plan or image without one.

| Image | Rows | Plans | Digest of the base |
| --- | --- | --- | --- |
| `rocky8` | 255 | 412 | `rockylinux@sha256:9794037624aaa6212aeada1d28861ef5e0a935adaf93e4ef79837119f2a2d04c` |
| `debian11` | 264 | 421 | `debian@sha256:6f519a81440354a85eb592c5f32109ab80605f6b892455983a6f618bf87fabe9` |
| `rocky9` | 264 | 421 | `rockylinux@sha256:d7be1c094cc5845ee815d4632fe377514ee6ebcf8efaed6892889657e5ddaaa6` |
| `ubuntu2204` | 264 | 421 | `ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956` |
| `debian12` | 264 | 421 | `debian@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858` |
| `ubuntu2404` | 264 | 421 | `ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac` |
| `debian13` | 264 | 421 | `debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5` |

## Run 3: after the review

The S8 review found the runs not tied to what they ran, and rows that could never disagree
(`TASKS.md`, `P-432` S8 review). After the fixes, the rows changed in three ways. The 6 rows asking
for the IP literal `192.0.2.1` are gone: Node answers a literal itself, so glibc was never asked.
Two rows were added, `attempts:9` at `timeout:1` and two servers at `timeout:1 attempts:2`. And
four rows with one candidate and a short wait gained an `all-silent` plan, in which every server
is silent. That leaves 260 rows (251 on Rocky 8) and 2,966 plans. Each image's run now carries the
sha256 of the rows file and of the policy's build, and the verdict holds both to the files as they
were. Each base was the digest recorded by run 2, pinned rather than pulled by tag.

**The first attempt was stopped after Rocky 8**, on a fault in the replay, not in glibc. The S5
simulator models a forwarder, and a question that is never answered holds its slot for 10 s,
taking in every identical question meanwhile. So in the plan after `all-silent`, glibc's
questions joined the held ones and went unanswered, and glibc asked every try again: 10
questions where `answer` expects 2, and 8 where `last-answers-after-servfail` expects 4. Run 2
never showed this, because its only silent plan came last in each row, and each row starts a
simulator of its own. Every replay server now holds a slot for 1 ms (`NAMESERVER`), which
releases it before glibc's next try or the next plan. A box run of the four silent rows in
`debian12` then agreed on all 14 plans.

**Run 3 passed.** 260 rows in each image (251 on Rocky 8), **2,966 plans, every one
agreeing**, each image's rows in 107–127 s and the whole run in 830 s. Every image's run named the
same rows file and the same policy build, and Ubuntu 24.04's run saw resolved serve the stub,
asking upstream once for each of glibc's questions. The recordings are rewritten (schema 2): 2,966
of them, each image's entry with the two digests, and the stub plans with what resolved asked
upstream.

**What the silent plans show**, the same in every image:
- `timeout:0 attempts:1`: one try, A and AAAA once each, `EAI_AGAIN` after about 1 s.
- `attempts:9` at `timeout:1`: five tries (RES_MAXRETRY), about 5 s.
- Two servers at `timeout:1 attempts:2`: server 1 and then server 2 on try 1, and again on try 2,
  about 4 s: each server for 1 s, the second's `(1 << 1) / 2`.
- `timeout:3`, two attempts: two tries, about 6 s.

## Through systemd-resolved

In `ubuntu2404` the stub rows were played through resolved: glibc asked 127.0.0.53, read off
`lo`, and resolved asked the simulator at 127.0.0.2.
- `search .`: glibc asked the stub `sw1` A and AAAA once each, in both plans.
- `search corp.example`: glibc asked `sw1.corp.example` and then `sw1` under NXDOMAIN, and only
  `sw1.corp.example` when it was answered.

With `Cache=no`, resolved asked upstream exactly one question for each of glibc's. To answer as
the plan says, resolved needs `ResolveUnicastSingleLabel=yes`: without it, it answers a
single-label name SERVFAIL itself, and glibc asks it a second time. It also needs a link with a
routable address: with no network, it answers every question SERVFAIL at once, without asking
upstream.

## Timings, for the record

- `local` rows returned in at most 115 ms, inside the lookup's own process.
- Walked plans took a median of 8–10 ms.
- Silent plans with three servers took 8.0–8.1 s, with the default 5 s at the first server and
  `5 << 1` / 3 at the second.
- Rotating silent plans took 8 ms to 5.05 s, by the server glibc started at.

## Not measured here

- The walk's own wire, D30's recording (B), needs S6 (`P-460`). So do the regression and budget
  rows of the design's §7.5.
- No box has the check off (nscd, `libnss-resolve`, `mdns4_minimal`, `LD_PRELOAD`): `P-461`.
