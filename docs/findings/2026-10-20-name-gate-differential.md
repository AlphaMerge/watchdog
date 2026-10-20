# The name gate's policy against glibc, in seven images (`P-432` S8)

2026-10-20, on `feat/p432-s8-diff` (on `f762dfc6`). `scripts/smoke/name-gate-differential.sh`,
the whole run three times: first on S4's policy as it landed, then on the policy narrowed by what
the first run found, and then after the review's fixes (run 3). Run 4, on `feat/p432-s8-walk`,
adds the walk's wire, the regressions, the answer rows, the budget boxes and the boxes with the
check off (`P-460`, `P-461`). Runs 5 and 6 follow the review of run 4. Run 7 follows the second
fix round, which put the answer rows' world in their digest. Run 8, on `feat/p432-s8-r3`, adds
§7.5's other rows (`P-462`): five more boxes with the check off, two sequence rows, three of S4's
rows and three boxes with a file edited mid-run. Run 9 follows the review of run 8: one more box
with the check off, for `nameserver 10.1`, and a fourth skew box. Its recordings are the committed
ones. Built first, then:

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

## Run 7: the answer rows' world in their digest

2026-10-20 (04:11 to 04:56 UTC), on `feat/p432-s8-walk` after `P-460`'s fix round 2, on the bases
run 4 pinned and the same policy build (`e19f270b…`). Built first, then the whole run, as above.

**What the fix round changed in what a run holds.** The answer rows' digest (`answerRowsDigest`)
is now the sha256 of the answer rows with their world (`ANSWER_WORLD`: the hostname, the
environment the lookup gets, the hosts file, nsswitch.conf and gai.conf), where before it was of
the rows alone. The replay reads that world from one place (`answerRowWorld`), and names in its run
the digest of the world it played. Nothing the boxes do changed, so run 7 is run 6 again under a
digest that names more: the committed recordings, which named run 6's digest of the rows alone,
no longer stood for the answer rows as committed, and were re-made rather than edited.

**Run 7 passed**, in all seven images: 260 rows in each (251 on Rocky 8), 2,966 plans, 2,128
heard, 70 silent and 768 local, as in runs 4 and 6. Every image's run and every box's named the
same build (`de95fa8d…`), none saw it change, and every image's run named the same rows file
(`44aa6cb3…`), answer rows and world (`862bddd8…`) and policy build. The recordings are rewritten
from it: 2,966 recordings and 42 answer recordings. Against run 6's, the plans and answer rows
recorded are the same ones; what differs is each lookup's time, and for 32 rotating plans the
server glibc started at (its wire and OPT flags with it).
- Each image's replay took 337–384 s from its box's start.
- A heard walk took a median of 2.0 ms, 9.2 ms at the 99th percentile and at most 25.7 ms. A
  silent one took 250–263 ms.
- Every answer row in every image returned what it claims, its walk heard: `answer:2` with and
  without `edns0` for TC with TCP/53 refused, `ENOTFOUND` for FORMERR, `answer:1` for A answered
  with AAAA SERVFAIL, `ENOTFOUND` for FORMERR to OPT, and `EAI_AGAIN` after 1,007–1,017 ms for
  the EDNS-deaf server.
- The budget boxes: dnsmasq held 6, 8 and 10 distinct questions at once (`system`, gate, gate
  after a helper SIGKILL; 18, 20 and 22 in the window), its table never full. systemd-resolved
  held 10 in `system` and 9 in gate mode (12 and 14 in all). All as in run 6.
- The five off boxes: each off by its rule, the check started and routing `unvouched:off`, and 0
  questions asked.

## Run 8: §7.5's other rows (`P-462`)

2026-10-20 (07:45 to 08:58 UTC), on `feat/p432-s8-r3` (on `1b6bd68a`), on the bases run 4 pinned.
Built first, then the whole run, as above, bounded at 150 minutes.

**What it adds.** Each of the §7.5 rows that `P-462` listed, which `P-460` and S4 had left out, is
now a row or a box, and the run fails unless each holds:

| §7.5's row | Played as | What it must show |
| --- | --- | --- |
| `sss` before `files` | off box `sss-first`: Debian 12, `libnss-sss`, `hosts: sss files dns` | off by `nsswitch`, naming "sss" |
| `mdns4_minimal` before `files` | off box `mdns4-first`: Debian 12, `libnss-mdns`, `hosts: mdns4_minimal files dns` | off by `nsswitch`, naming "mdns4_minimal" |
| `files resolve dns` | off box `files-resolve-dns`: Ubuntu 24.04, `libnss-resolve` | off by `nsswitch`, naming "resolve" |
| the stub refused under `resolve` | off box `stub-refused`: Ubuntu 24.04 booted, resolved with `DNSStubListener=no` | the stub bound to nothing over UDP or TCP, resolv.conf naming it alone, the package's hosts: line; off by `nsswitch` |
| `LOCALDOMAIN=""` | off box `localdomain-empty`: Debian 12 | off by `env` |
| a `%scope` hosts line | three of S4's rows: `routerlo` (`fe80::3%lo`), families 0, 4 and 6 | glibc skips the line and asks DNS, as the policy says |
| a partial key | sequence row `sequence-partial-key` | four lookups through one check, each heard or silent as its key is |
| `_gateway` for family 6 on a v4-only host | sequence row `sequence-gateway-v4-only` | nothing asked for families 4 and 0, `_gateway` AAAA once for 6 |
| mid-run edits, then a helper SIGKILL | skew boxes `gai` (Debian 12), `nsswitch-frozen` (Debian 11) and `nsswitch-reloaded` (Debian 12) | D28's rest until restart for a file read once, and none for one reloaded |

The list missed one of §7.5's rows, `nameserver 10.1`, which run 8 therefore did not cover; run 9
adds its box.

Every off box is held as `P-461`'s are: the policy loaded in situ, the check off by the rule
named, a name routed `unvouched:off`, and nothing asked from the check's start to its stop.

**The sequence rows** are of the answer rows' kind: claims in `names-differential.ts`, played in
every image in the answer rows' world with the row's own resolv.conf and nsswitch.conf, and named
in the answer rows' digest (now of `{ world, rows, sequences }`). Each lookup has one plan. glibc
is asked for each lookup in turn, each in its own process (A). Then one check walks them all in
turn, and each lookup's regression follows (B).
- **The partial key.** One zone and one server, `timeout:1 attempts:1`. Its upstream is silent,
  but two of the zone's names are in its cache: the S5 simulator has a cache for this, primed for
  each server. In turn:
  - a cached name, heard as the key's scout;
  - an uncached one, silent: the key is heard, so the name's own step goes, from the heard pool
    with both types at once;
  - the second cached name, heard on a walk of its own: the key is now mixed;
  - the second uncached name, silent, from the discovery pool one type at a time. Its walk stops
    at A's silence, one question where glibc asked two, which the fidelity rule allows ("up to
    where each stops").

  glibc asked A and AAAA for each. It returned `answer:2` in 8–45 ms for the cached names, and
  `EAI_AGAIN` after 1,010–1,050 ms for the others. Gate mode ran the heard names on the lanes and
  the silent ones in the helper.
- **`_gateway`.** A dummy link has an IPv4 default route through 198.19.0.254 and no IPv6, under
  `hosts: files myhostname dns`. The check cannot vouch (`systemd-name`): it routes the name
  `unvouched:cannotVouch` to the helper and asks nothing, and the helper answers as the lanes do.
  nss-myhostname answers families 4 and 0 from the route (`198.19.0.254`, no question). For
  family 6 there is no IPv6 gateway, so myhostname says NOTFOUND, and `_gateway` AAAA is asked
  once.
- **`%scope`.** S4's export already held `router` (`fe80::1%eth0`), verified in run 7, but no box
  has an `eth0`. `routerlo` names `lo`, which every box has, so glibc skipping the line is the
  hosts parser's rule (`inet_pton` takes no scope) and not an interface it could not find.

**The skew boxes** (`names-skew.ts`) run ms-probe's name resolution in gate mode, built as
`main.ts` builds it, in a world the check is on for, with its log read back. The check must be on
and proven, the helper up, and a name answered. Then the case's file is edited and the watch's
look waited for to its end, and the helper's child is SIGKILLed from outside. The box then waits
for the helper to settle and holds 5 s past every backoff.
- `gai` (gai.conf at 2.36, no `reload yes`) and `nsswitch-frozen` (nsswitch.conf at 2.31): the
  check off by `skew` naming the file, the helper marked skewed, and "restart ms-probe to apply
  it" logged for the file. After the SIGKILL the helper rests until restart: no timed rest, no new
  child, `nameResolverMode` 3, the trouble latch set, the resting line logged, and the next name
  asked as `system` asks it, with no lookup to the helper.
- `nsswitch-reloaded` (nsswitch.conf at 2.36): the check off by `skew`, the helper not marked
  and no restart owed. After the SIGKILL the helper is up in a new child, mode 2, trouble 0, and
  it takes the next name.

**What the narrowed runs found first.** Three narrowed runs came before the whole run: the new
rows and boxes alone, then the two runs of the box mutants, in which every box not mutated had to
pass as well. Each finding was a box's own fault, not the policy's or ms-probe's.
- **With `DNSStubListener=no`, systemd 255 makes its stub file a link to its uplink file.** The
  first `stub-refused` box copied the stub file after the restart. It read
  `nameserver 192.168.65.7` there: Docker's DNS, which resolved had taken from the box's own
  resolv.conf. Ubuntu links /etc/resolv.conf to the stub file, so there, turning the stub off sends
  glibc to the uplink servers and nothing is refused. A refused stub needs a resolv.conf of its own
  that names 127.0.0.53, such as one copied from the stub file while it listened. The box now
  writes that copy, then turns the stub off.
- **The helper keeps no process alive.** The `nsswitch-reloaded` box's in-situ process exited 13
  on an unsettled top-level await. With the check off, its second name went to the helper, whose
  child, channel and timers are all unref'd, so the loop drained. In ms-probe its other handles
  keep the loop alive. The box's lookups now have bounds of their own (`within`), whose timers do.
- **The check goes off before the helper is told.** Once in two runs the `gai` box read no
  "restart ms-probe" line. The policy turns the check off inside the watch's look and tells the
  helper after an await, and the box had looked in between. The box now waits for the look's last
  line.

Six mutants of the boxes, each shown failing the run with its own `DISAGREES` lines, in two
narrowed runs (`P-462` in `TASKS.md`).

**Run 8 passed**, in all seven images and with every box. Each image played 263 rows (254 on
Rocky 8), 3,008 plans in all: 2,170 heard, 70 silent and 768 local. The 42 plans more than run 7
are the three `routerlo` rows, two plans each in each image, all heard. In every image glibc
skipped the line and asked as the policy says: the row's search list, `routerlo.corp.example`,
then `routerlo` under NXDOMAIN. Every image's run and every box's named the same build
(`15d1ca61…`), and none saw it change. Every image's run named the same rows file (`330e92b9…`),
the same answer rows, sequence rows and world (`782847aa…`), and the same policy build
(`a0bd6418…`). The recordings are rewritten from it: 3,008 recordings, 42 answer recordings and
49 sequence recordings (seven lookups in each of seven images).
- **Pace.** Each image's replay took 389–920 s from its box's start, against run 7's 337–384 s.
  Other sessions' suites shared the VM, and the host's load average stood at 12–14 for the run's
  first half. A first attempt was stopped after 19 minutes, before any verdict, when Rocky 8
  alone had taken 637 s and the run's 90-minute bound looked short. This run had 150.
- **Walks.** A heard walk took a median of 2.5 ms, 32.3 ms at the 99th percentile and at most
  88.1 ms (run 7: 2.0, 9.2 and 25.7 ms). A silent one took 247–270 ms. glibc took at most 232 ms
  on a plan whose walk was heard. Where the walk was silent and glibc slow, glibc took at least
  1,009 ms. A `local` plan returned in at most 167 ms.
- **The sequence rows**, in every image, held as above. The `_gateway` lookups returned
  `answer:1` in 6–43 ms: 198.19.0.254 for families 4 and 0 with no question asked, and the
  simulator's AAAA for family 6 after its one question. Every one of them ran in the helper.
- **The budget boxes.** dnsmasq held 6, 8 and 10 distinct questions at once (`system`, gate, and
  gate after a helper SIGKILL; 18, 20 and 22 in the window), and its table was never full.
  systemd-resolved held 10 in `system` and 11 in gate mode (12 and 14 in all; run 7 had 9 in
  gate), inside the bound of `system` + 12.
- **The ten off boxes**: each off by its rule, the check started and routing `unvouched:off`, and
  0 questions asked. In `stub-refused`, resolved was active and nothing was bound to
  127.0.0.53:53. resolv.conf was the stub file as written while it listened (`nameserver
  127.0.0.53`, `options edns0 trust-ad`, `search .`), and the hosts: line was the package's,
  `files resolve [!UNAVAIL=return] dns myhostname`.
- **The three skew boxes**, as claimed:
  - In `gai` and `nsswitch-frozen` the check went off by `skew`, naming the file ("changed since
    ms-probe started … the check is off until ms-probe restarts"), and the restart line was logged
    once, for that file, as the edit's look ended. That was read before any later look, and each
    case edited the first file read once at its glibc, so it could not fail for the fallback the
    review found (run 9). After the SIGKILL the helper rested with no timed rest, at mode 3 with
    trouble 1 and one resting line, and the next name was answered with 0 lookups to the helper.
  - In `nsswitch-reloaded` the check went off by `skew` with no restart line. After the SIGKILL
    the helper was up in a new child, at mode 2 with trouble 0, and took the next name.

## Run 9: the review's fixes (`P-462` fix round 1)

2026-10-20 (09:56 to 10:52 UTC), on `feat/p432-s8-r3`, on the bases run 4 pinned. Built first,
then the whole run, as above, bounded at 150 minutes. Not a quiet run: the VM gate was at 1 when it
started, and the host's load average at 14.

**What the review found, and what changed.**
- **A look after a read-once file moved named another file.** When the policy was skewed and a
  look had moved nothing, ms-probe marked the helper with the first file read once. At glibc 2.31
  an edit to gai.conf logged "/etc/gai.conf changed: restart ms-probe to apply it" at its look, and
  "/etc/nsswitch.conf changed: …" at the next, five seconds later. ms-probe now marks exactly the
  files the policy names as skewed, at every look.
- **Run 8's skew boxes could not have seen it.** Each read the restart lines as the edit's look
  ended, and each read-once case edited the first file read once at its glibc. Each box now waits
  for a look after the edit's to end and reads the lines again, and a fourth box, `gai-not-first`,
  edits gai.conf at Debian 11, where nsswitch.conf comes first. Against ms-probe as it was, that box
  read `["/etc/gai.conf","/etc/nsswitch.conf"]` by the run's end (a narrowed run, `P-462` in
  `TASKS.md`).
- **`nameserver 10.1` had no box.** It is now the off box `nameserver-aton`: Debian 12, resolv.conf
  naming `10.1` alone. The policy reads a nameserver line only as a dotted quad or an IPv6 address,
  so the check is off for it, by `resolv`.
- **The partial key's cache sat outside the digest.** The addresses it held and their TTL are now
  in the row, so the answer rows' digest names them, and the replay primes the cache from the row.
  The digest moved, so the recordings had to be made again: this run's are the committed ones.
- **A helper resting until restart is held to having no child**, the one killed included, and any
  child but the one killed counts as a new one whatever the helper's state says.

**Run 9 passed**, in all seven images and with every box. Each image played 263 rows (254 on
Rocky 8), 3,008 plans in all: 2,170 heard, 70 silent and 768 local, the same plans as run 8.
Every image's run and every box's named the same build (`7cf684b8…`), and none saw it change.
Every image's run named the same rows file (`330e92b9…`), the same answer rows, sequence rows and
world (`e7ed6c37…`), and the same policy build (`ae2c892f…`). The recordings are rewritten from
it: 3,008 recordings, 42 answer recordings and 49 sequence recordings.
- **Pace.** Each image's replay took 350–726 s from its box's start.
- **Walks.** A heard walk took a median of 2.2 ms, 18.4 ms at the 99th percentile and at most
  51.8 ms. A silent one took 250–262 ms. glibc took at most 164 ms on a plan whose walk was heard.
  Where the walk was silent and glibc slow, glibc took at least 1,009 ms. A `local` plan returned in
  at most 85 ms.
- **The answer rows and the sequence rows** returned what each claims in every image. The partial
  key's cached names returned `answer:2` in 7–33 ms on the probe's lanes, and its uncached ones
  `EAI_AGAIN` after 1,007–1,035 ms in the helper. The `_gateway` lookups returned `answer:1` in
  6–14 ms, every one in the helper.
- **The budget boxes.** dnsmasq held 6, 8 and 10 distinct questions at once (`system`, gate, and
  gate after a helper SIGKILL; 18, 20 and 22 in the window), and its table was never full.
  systemd-resolved held 9 in `system` and 9 in gate mode (12 and 14 in all).
- **The eleven off boxes**: each off by its rule, the check started and routing `unvouched:off`,
  and 0 questions asked. In `nameserver-aton`, resolv.conf was `nameserver 10.1` alone, and the
  check was off by `resolv`: "resolv.conf line 1: a nameserver line names one IPv4 or IPv6
  address, no scope, and nothing after it".
- **The four skew boxes**, as claimed, each with one look after the edit's by its end:
  - In `gai`, `gai-not-first` and `nsswitch-frozen` the check went off by `skew` naming the file,
    and the restart line was logged for that file alone, both as the edit's look ended and by the
    run's end. The policy read gai.conf and /etc/ld.so.preload as read once at 2.36, and
    nsswitch.conf, gai.conf and /etc/ld.so.preload at 2.31. After the SIGKILL the helper rested
    with no timed rest and no child, at mode 3 with trouble 1, and the next name was answered with
    0 lookups to the helper.
  - In `nsswitch-reloaded` the check went off by `skew` with no restart line, then or later. After
    the SIGKILL the helper was up in a new child, at mode 2 with trouble 0, and took the next name.

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
- What glibc asks under `resolve`, `sss` or `mdns4_minimal`, with the stub refused, or of a server
  named `10.1` (10.0.0.1 to glibc): the check is off for each, so each is a box that claims no
  wire, only the check off by its rule and nothing asked (`P-461`, `P-462`).
- Timings: no run here is a quiet one, and none needs to be. The 1 s line is far from where load
  could move a plan across it: glibc took at most 137 ms on a plan whose walk was heard (232 ms in
  run 8, on a loaded VM), and load only slows it; where the walk was silent and glibc slow, glibc took at least 1,009 ms, waiting
  out a 1 s try, which load cannot shorten.
