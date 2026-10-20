# The name gate's policy against glibc, in seven images (`P-432` S8)

2026-10-20, on `feat/p432-s8-diff` (on `f762dfc6`). `scripts/smoke/name-gate-differential.sh`,
the whole run three times: first on S4's policy as it landed, then on the policy narrowed by what
the first run found, and then after the review's fixes (run 3). Run 4, on `feat/p432-s8-walk`,
adds the walk's wire, the regressions, the answer rows, the budget boxes and the boxes with the
check off (`P-460`, `P-461`). Runs 5 and 6 follow the review of run 4, and run 6's recordings are
the committed ones. Built first, then:

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

## Run 4: the walk beside glibc, the answer rows, the budget and the boxes with the check off

2026-10-20, on `feat/p432-s8-walk` (on `a95c3302`, with S6 landed), `P-460` and `P-461`. Built
first, then the whole run, as above. Each base was the digest run 3 recorded, pinned. The policy's
build is S6's (`dist/src/resolver/system-names.js`, sha256 `e19f270b…`), so the committed
recordings, made on S8's build (`b3aaf3cf…`), were stale by that digest.

**What it adds.** After glibc's wire (A), each plan is played again with the same answers for the
walk alone (B): `DnsCheck.route` in a process of the row's own (`names-modes.ts`), with a budget
and c-ares of its own and no lanes or helper, proven by its canary. In run 4 the canary was
asked with the plan's answers already set, and was answered only because the S5 simulator answers
`localhost` itself, whatever the plan says; run 5 has every server answer NXDOMAIN until the
checks are proven. The same process then makes §7.5's regression lookups at once: through the probe's resolver in
`system` mode and in `gate` mode, in the helper's child, and on the probe's lanes. Every
resolver is new for each plan, so every cache is cold. Then six answer rows in every image, two
budget boxes and five boxes with the check off.

**Run 4 passed.** 260 rows in each image (251 on Rocky 8), **2,966 plans, each walk agreeing with
glibc's wire and every regression holding**, the 6 answer rows in every image (42 recordings),
both budget boxes and the five boxes with the check off. Each image's box took 303–494 s from its
start (run 3: 107–127 s, with no walk or regression), and the whole run about 50 minutes, from
00:33 to 01:22 UTC. Those times are the script's per-image lines, which counted the six answer rows
as rows ("266 rows", "257" on Rocky 8) and, for Ubuntu 24.04, held the resolved budget box's 72 s:
its replay took about 317 s. Run 5's lines count each kind and stop before the budget box. Every image's run named the same rows file (`44aa6cb3…`) and policy build, and Ubuntu 24.04's
saw resolved serve the stub. The recordings are rewritten, schema 3: 2,966 recordings and 42
answer recordings, each with glibc's OPT flags.

**The walk against glibc**, in every image:
- **2,128 plans heard, 70 silent and 768 local** across the seven images (304, 10 and 111 in each
  but Rocky 8, which has 102 local). Each walk asked each question once: 679 questions in each
  image's walks against 696–708 of glibc's. glibc asks again on its second tries and over TCP
  after TC, and the walk, under `rotate`, asks every server where glibc asks one.
- A heard walk took a median of 1.8 ms, 16.6 ms at the 99th percentile and at most 36 ms. A silent
  one ended at its routing wait, in 250–304 ms.
- Every silent walk's plan had glibc return after 1 s, but for the two rotating rows'
  `last-answers-after-silent` in some images (7 plans in all, 0 to 2 an image), where glibc
  started at a server that answered and returned in 7–9 ms. That is rotate's one-way rule: the
  walk asks every server at once, and a silent one holds it.
- Gate mode ran every heard and local name on the probe's lanes and every silent one in the
  helper.

**The answer rows**, the same in every image:

| Row | glibc's wire | glibc | The walk |
| --- | --- | --- | --- |
| TC from server 1, its TCP/53 refused | server 1 A, AAAA over UDP; server 2 A, AAAA over TCP | the answer, 11–18 ms | heard, both servers over UDP |
| the same under `edns0` | the same, each with OPT | the answer | heard, no OPT |
| FORMERR from server 1 | server 1 A, AAAA | `ENOTFOUND`; server 2 never asked | heard at server 1 |
| A answered, AAAA SERVFAIL, server 2 silent | server 1 A, AAAA | the A alone; server 2 never asked | heard at server 1 |
| FORMERR to a question with OPT, under `edns0` | server 1 A, AAAA, with OPT | `ENOTFOUND`: no retry without EDNS | heard: its questions carry no OPT |
| one server dropping questions with OPT (`P-454`) | server 1 A, AAAA, with OPT | `EAI_AGAIN` after 1 s | heard |

The last is `P-454`'s known limit, asserted as it is. The run fails if either side moves. In
every plan of every row, glibc's questions carried an OPT record exactly where the policy read
`options edns0`, and the check's never did.

**The regressions.** In every plan of every image, gate mode answered as `system` mode did, the
helper's child as the probe's lanes, and gate mode ran each name where its walk said: heard and
local names on the probe's lanes, silent ones in the helper.

**The budget boxes.** 150 names of a silent zone asked at once, family 0, for 30 s, by the
probe's resolver in a process of its own with `UV_THREADPOOL_SIZE` 16. The upstream is the S5
simulator at 127.0.0.2, holding a slot per distinct question for 10 s as dnsmasq does, so its
peak is the distinct questions the forwarder had open upstream at once.

| Forwarder | Arm | Held at once, at most | Distinct in 30 s | Bound | Table full |
| --- | --- | --- | --- | --- | --- |
| dnsmasq 2.90, `dns-forward-max=30` | `system` | 6 | 18 | | 0 |
| | gate | 8 | 20 | 18 | 0 |
| | gate, helper SIGKILLed 5 s in | 10 | 22 | 34 | 0 |
| systemd-resolved 255 | `system` | 8 | 12 | | |
| | gate | 9 | 14 | 20 | |

A narrowed run before run 4 measured the same at dnsmasq, and 10 and 9 at resolved.

`system` holds 6 at dnsmasq: the zone's 3 lanes in an outage (`P-438`'s "unacked: 3", a cold
probe in the middle of the outage), A and AAAA each. Gate mode adds the walk's questions, well
within D16's 12, and after a helper SIGKILL 5 s in, within D16's transient too. dnsmasq never
said its table was full.

**The boxes with the check off** (`P-461`), each the policy loaded in situ:

| Box | Image | What the box had | Off by |
| --- | --- | --- | --- |
| nscd | Debian 12 | nscd running, `/var/run/nscd/socket` | `nscd` |
| libnss-resolve | Ubuntu 24.04 | `files resolve [!UNAVAIL=return] dns myhostname` | `nsswitch`: an action group |
| libnss-mdns | Debian 12 | `files myhostname mdns4_minimal [NOTFOUND=return] dns` | `nsswitch`: an action group |
| LD_PRELOAD | Debian 12 | libresolv preloaded by the environment | `env` |
| /etc/ld.so.preload | Debian 12 | libresolv named in the file | `env` |

In each, the check routed `sw1.example.test` `unvouched:off` with nothing asked. The hosts:
lines are the packages' own. Run 4's box never started the check, so its canary could not have
gone, and "nothing asked" held of the route alone; run 5 starts it as the probe does, and holds it
to having asked nothing from its start to its stop.

## Runs 5 and 6: after the review of run 4

2026-10-20, on `feat/p432-s8-walk` after `P-460`'s fix round 1, on the bases run 4 pinned and the
same policy build (`e19f270b…`). Built first, then the whole run each time, as above.

**What the fix round changed in what a run holds.**
- Under `rotate` the plan decides whether the walk is heard. Where one of the row's servers is
  silent to a type asked, the walk must be silent, whatever glibc's time. Where every server
  answers, heard if and only if glibc returned within 1 s. The walk's types are glibc's too: none
  that glibc did not ask of a name, and each one glibc asked of a name the walk went past or was
  heard at, of every server.
- Each answer row claims what `getaddrinfo` returns, and the run is held to it.
- The off boxes start the check as the probe does, and nothing may be asked from its start to its
  stop, its canary included.
- Each image's run names the answer rows it played (`answerRowsDigest`). Every run, an image's or
  a box's, names the build it loaded (`buildDigest`, every `.js` the boxes load), and fails if
  that build's files moved under it: each looks again before each row and at its end.
- Every server answers NXDOMAIN while the checks are proven, and the plan's answers are set after.
- The script's per-image line counts rows and answer rows apart, and stops before the resolved
  budget box, which has a line of its own.

Run 4's own runs, judged again by the fix round's verdict with the digests they could not carry
filled in, have 0 problems: the stricter checks hold of what glibc and the walk did then.

**Run 5 failed on one plan** (02:17 to 03:05 UTC). In Ubuntu 24.04, row `26f320fa4e698d6f` (two
silent servers at `timeout:1 attempts:2`), plan `last-answers-after-silent`: the walk was routed
`unvouched:stall`, 577 ms after it was asked, against its 250 ms routing wait. The check's
deadline timer fired about 330 ms late, as when the event loop is starved, and D31 then routes a
lookup unvouched rather than take silence from it. The same plan's walk took 250–258 ms in every
other image and in run 4. A walk with no verdict leaves its plan unverified, so the run failed,
as it should. Everything else held, and run 6 was the whole run again.

**Run 6 passed** (03:06 to 03:54 UTC), in all seven images: 260 rows in each (251 on Rocky 8),
2,966 plans, 2,128 heard, 70 silent and 768 local, as in run 4. Every image's run and every box's
named the same build (`51c80c25…`), none saw it change, and every image's run named the same rows
file (`44aa6cb3…`), answer rows (`0384c163…`) and policy build. The recordings are rewritten
from it: 2,966 recordings and 42 answer recordings, each image with its answer rows' digest.
- Each image's replay took 350–459 s from its box's start.
- A heard walk took a median of 2.1 ms, 13.1 ms at the 99th percentile and at most 45.6 ms. A
  silent one took 250–261 ms.
- Under `rotate`, 7 plans had a silent walk beside a glibc that returned within 1 s, each a
  `last-answers-after-silent` plan, which has a server silent. No plan that every server answers
  had a silent walk.
- Every answer row in every image returned what it claims: `answer:2` with and without `edns0`
  for TC with TCP/53 refused, `ENOTFOUND` for FORMERR, `answer:1` for A answered with AAAA
  SERVFAIL, `ENOTFOUND` for FORMERR to OPT, and `EAI_AGAIN` after 1,009–1,015 ms for the
  EDNS-deaf server.
- The budget boxes: dnsmasq held 6, 8 and 10 distinct questions at once (`system`, gate, gate
  after a helper SIGKILL), its table never full, as in run 4. systemd-resolved held 10 in
  `system` and 9 in gate mode, against a bound of 22 (run 4: 8 and 9).
- The five off boxes: each off by its rule, the check started and routing `unvouched:off`, and 0
  questions asked.

**The fix round's mutants in the boxes**, in one narrowed run before run 5, each its own
`DISAGREES` line: the canary allowed to ask with the check off (all five off boxes said the check
asked `localhost.` of the box's server), the replay naming answer rows it did not play, and a
built file written again with its own bytes while Debian 12 replayed ("its build changed while
it ran").

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

- The check's own OPT record: c-ares sends none, and run 4 asserts that it does not (`P-454`).
- §7.5's rows beyond `P-460`'s and S4's: `sss` or `mdns4_minimal` before `files`, `files resolve
  dns`, the stub refused under `resolve`, a `%scope` hosts line, a partial key, mid-run edits of
  gai.conf and nsswitch.conf with a helper SIGKILL, `_gateway` for family 6 and
  `LOCALDOMAIN=""` (`P-462`).
- Timings: no run here is a quiet one, and none needs to be. The 1 s line is far from where load
  could move a plan across it: glibc took at most 137 ms on a plan whose walk was heard, and load
  only slows it; where the walk was silent and glibc slow, glibc took at least 1,009 ms, waiting
  out a 1 s try, which load cannot shorten.
