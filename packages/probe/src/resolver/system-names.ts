import { open, readFile, stat, type FileHandle } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@ms/shared';
import {
  DIGEST_ABSENT,
  digestOf,
  digestOfError,
  glibcRuntime,
  unreadableDigest,
} from './lookup-helper-child.js';
import type { Family, WatchedReading } from './name-resolver.js';

/**
 * What the system does with a name before and around DNS (`P-432`, slice S4): the gate's reading of
 * the files glibc's `getaddrinfo` reads, so that the DNS check asks what glibc would ask and knows
 * which names glibc answers with no network at all.
 *
 * **It decides no answer.** Every answer is still `getaddrinfo`'s. What this decides is where a
 * lookup runs (`P-432` §1.3): `local` names on the probe's lanes, never walked; names the check
 * cannot vouch for, and every name while the check is off, in the lookup helper; every other name
 * walked, with the candidates and the types glibc would ask. A slip here can move a lookup between
 * the lane sets or cost it the routing wait, never change what it resolves to (§2).
 *
 * **An allowlist.** The check is on only on a system whose every setting has one of a few shapes,
 * each read alike by every glibc from 2.28 to 2.42, and off everywhere else, naming the first rule
 * that failed (`CheckOff`). Off costs a name a lane in the helper; a shape read wrongly would route
 * it wrongly. While the check is off nothing is `local` either. It is on only while all of these
 * hold, checked in this order:
 *
 * 1. Linux, and glibc 2.28 to 2.42 by the version it runs (`glibcRuntime`).
 * 2. resolv.conf has only the lines `readResolvConf` allows.
 * 3. The probe's environment has no `LOCALDOMAIN`, `RES_OPTIONS` or `HOSTALIASES`, and
 *    `LD_LIBRARY_PATH`, `LD_PRELOAD` and `LD_AUDIT` are unset or empty (`environmentOff`); and
 *    /etc/ld.so.preload is absent or empty.
 * 4. nsswitch.conf has one `hosts:` line, `files dns`, `files dns myhostname` or
 *    `files myhostname dns`, and no other line with an action group (`readNsswitch`), and glibc
 *    can load every module the hosts: line names.
 * 5. nscd is not running.
 * 6. The hosts file and gai.conf can be read (a narrowing), and nothing else the check read at
 *    load has moved since: the contents of resolv.conf, nsswitch.conf, gai.conf or
 *    /etc/ld.so.preload, the hostname's domain while the search list is the hostname's, or a
 *    module (`GlibcNamePolicy`).
 *
 * **The narrowings** (`NARROWINGS`). Most shapes the check is off for are ones glibc versions read
 * differently, or that the walk does not model. A few are not: every glibc from 2.28 to 2.42 reads
 * them alike, and the check could follow them, but it is off for them all the same, because it
 * vouches only on the shapes it was built for. Each is named on the reason it gives
 * (`CheckOff.narrowing`).
 *
 * **Sources.** glibc 2.28 and master (2.43 in development), which read every shape allowed here
 * alike, cited by file and function; nsswitch.conf(5) and resolv.conf(5); systemd's nss-myhostname.
 */

/** A glibc version as `[major, minor]`. */
export type GlibcVersion = readonly [number, number];
export type QType = 'A' | 'AAAA';
export type Environment = Readonly<Record<string, string | undefined>>;

/** The files the policy reads, and the socket it looks for. */
export interface SystemFiles {
  readonly hosts: string;
  readonly resolvConf: string;
  readonly nsswitchConf: string;
  readonly gaiConf: string;
  /** What ld.so preloads into every process (elf/rtld.c, `preload_file`). */
  readonly ldSoPreload: string;
  /** nscd's socket: `_PATH_NSCDSOCKET` in glibc's nscd/nscd-client.h. */
  readonly nscdSocket: string;
}

/** The files the policy reads, by their place in `SystemFiles`. */
export type SystemFileKey = 'hosts' | 'resolvConf' | 'nsswitchConf' | 'gaiConf' | 'ldSoPreload';

export const SYSTEM_FILES: SystemFiles = {
  hosts: '/etc/hosts',
  resolvConf: '/etc/resolv.conf',
  nsswitchConf: '/etc/nsswitch.conf',
  gaiConf: '/etc/gai.conf',
  ldSoPreload: '/etc/ld.so.preload',
  nscdSocket: '/var/run/nscd/socket',
};

/** The oldest glibc the check is on with: official Node builds need 2.28. */
export const GLIBC_FLOOR: GlibcVersion = [2, 28];
/** The newest glibc the allowlist has been read against: above it the check is off. */
export const GLIBC_CEILING: GlibcVersion = [2, 42];
/** From 2.33 nsswitch.conf is read again when it changes (glibc 2.33 NEWS, nss/nss_database.c). */
export const NSSWITCH_RELOADS_FROM: GlibcVersion = [2, 33];
/** From 2.34 `files` and `dns` are built into libc (glibc 2.34 NEWS); before, each is a module. */
export const NSS_BUILT_IN_FROM: GlibcVersion = [2, 34];
/**
 * From 2.29 the `dns` source refuses, before it asks, a name `res_hnok` rejects (BZ 24112:
 * resolv/nss_dns/dns-host.c `check_name`, NOTFOUND): for a name the check walks, one whose first
 * label begins with `-` (resolv/res_comp.c, later res-name-checking.c, `binary_leading_dash`).
 */
export const DNS_CHECKS_NAMES_FROM: GlibcVersion = [2, 29];
/**
 * How long one look of the system's name settings may take before the check is off for now
 * (`slow`) and the resolver's watch, which awaits each look, is let go. A hang detector, not a
 * budget: the reads are of a few small local files and library headers, which take milliseconds,
 * but one stall of the event loop runs this bound's timer before the poll that would deliver reads
 * already done (libuv runs timers first), and a module look's dozen or so file operations queue
 * behind a busy thread pool. So a look past it is a hang (`fault`, until restart) only when the
 * next look finds it still not ended.
 */
export const POLICY_LOOK_MS = 10_000;
/** The same for load, which reads every file once, and which S3's start awaits. */
export const POLICY_LOAD_MS = 30_000;
/** The name servers glibc asks (`MAXNS`, resolv/resolv_conf.c `update_from_conf`). */
export const MAXNS = 3;
/** `RES_MAXNDOTS`, `RES_MAXRETRANS`, `RES_MAXRETRY`, and the defaults (resolv/resolv.h). */
export const MAX_NDOTS = 15;
const MAX_TIMEOUT = 30;
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT = 5;
const DEFAULT_ATTEMPTS = 2;

/** Names systemd answers itself (nss-myhostname; resolved's `_localdnsstub`, `_localdnsproxy`). */
const SYSTEMD_NAMES: ReadonlySet<string> = new Set([
  '_gateway',
  '_outbound',
  '_localdnsstub',
  '_localdnsproxy',
]);

export function glibcVersionOf(text: string | null | undefined): GlibcVersion | undefined {
  const match = /^(\d+)\.(\d+)/u.exec(text ?? '');
  if (match === null) return undefined;
  return [Number(match[1] ?? Number.NaN), Number(match[2] ?? Number.NaN)];
}

export function atLeast(version: GlibcVersion, since: GlibcVersion): boolean {
  return version[0] > since[0] || (version[0] === since[0] && version[1] >= since[1]);
}

/**
 * **The digest of a system file**, the one contract the policy's snapshot and the lookup helper's
 * `ready` share (D28). Its other half is S2's `readOnceDigest` (lookup-helper-child.ts), which the
 * child computes for itself; the parent compares the two by string, so they must agree to the
 * character, or every helper reads as skewed. A read is one of three forms:
 * - **read**: sha256, in lower-case hex, of the file's bytes as read (`digestOf`; a string is taken
 *   as its UTF-8 bytes), so an empty file is e3b0c442…b855;
 * - **absent** (ENOENT): `DIGEST_ABSENT`, the word `absent`;
 * - **unreadable** for any other reason: `unreadable:<code>`, the error's code (`EACCES`, `EISDIR`),
 *   or `unreadable:unknown` with none (`unreadableDigest`).
 *
 * So an absent file is told from an empty one, and an unreadable one from both. The check decides
 * whether a file moved by this digest alone, never by its inode or times. **One function** for the
 * policy, the resolver's watch and the lookup helper's child (`P-432` S3): the child's module, which
 * imports only `node:*`, holds it, and this module hands it on.
 */
export { DIGEST_ABSENT, digestOf, digestOfError, unreadableDigest };

// --- C's character classes and number parsing, as glibc's parsers use them (C locale) ----------

const isCSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
const isDigit = (c: string | undefined): c is string => c !== undefined && c >= '0' && c <= '9';

function digitIn(c: string | undefined, base: number): number {
  if (c === undefined || c.length !== 1) return -1;
  const code = c.charCodeAt(0);
  let value = -1;
  if (code >= 48 && code <= 57) value = code - 48;
  else if (code >= 97 && code <= 102) value = code - 87;
  else if (code >= 65 && code <= 70) value = code - 55;
  return value < base ? value : -1;
}

const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/gu, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * C's `strtoul` with base 0 from a digit at `at`: hex after `0x`, octal after `0`, else decimal.
 * `0x` with no hex digit after it reads as `0` and stops at the `x`. The value is undefined past
 * 32 bits, which `inet_aton_end` refuses whether or not `strtoul` overflowed.
 */
function strtoul0(text: string, at: number): { readonly value: number | undefined; end: number } {
  let i = at;
  let base = 10;
  if (text[i] === '0') {
    if ((text[i + 1] === 'x' || text[i + 1] === 'X') && digitIn(text[i + 2], 16) >= 0) {
      base = 16;
      i += 2;
    } else {
      base = 8;
    }
  }
  let value = 0;
  let over = false;
  for (let digit = digitIn(text[i], base); digit >= 0; digit = digitIn(text[i], base)) {
    value = value * base + digit;
    if (value > 0xffffffff) over = true;
    i += 1;
  }
  return { value: over ? undefined : value, end: i };
}

/** The most each form's last part may hold: `a`, `a.b`, `a.b.c`, `a.b.c.d` (`inet_aton_end`'s `max`). */
const LAST_PART_MAX = [0xffffffff, 0xffffff, 0xffff, 0xff];

/**
 * glibc's `__inet_aton_exact` (resolv/inet_addr.c, `inet_aton_end`): the whole text an IPv4 address
 * in an `inet_aton` form, or undefined. Each part begins with a digit and is read by `strtoul` with
 * base 0; every part but the last is at most 255, and the last fills the bits left. Nothing may
 * follow. `getaddrinfo` parses these before NSS and nscd (sysdeps/posix/getaddrinfo.c,
 * `text_to_binary_address`), so it never asks DNS for one.
 */
export function inetAton(text: string): number | undefined {
  const parts: number[] = [];
  let i = 0;
  for (;;) {
    if (!isDigit(text[i])) return undefined;
    const { value, end } = strtoul0(text, i);
    if (value === undefined) return undefined;
    i = end;
    if (text[i] === '.') {
      if (parts.length > 2 || value > 0xff) return undefined;
      parts.push(value);
      i += 1;
      continue;
    }
    if (i !== text.length) return undefined;
    if (value > (LAST_PART_MAX[parts.length] ?? 0)) return undefined;
    return parts.reduce((sum, part, k) => sum + part * 2 ** (24 - 8 * k), 0) + value;
  }
}

/**
 * glibc's `inet_pton4` (resolv/inet_pton.c): exactly four decimal octets, none above 255, none with a
 * leading zero, and nothing else. What a hosts line's IPv4 address must be, and a `nameserver`'s.
 */
export function inetPton4(text: string): Uint8Array | undefined {
  const out = new Uint8Array(4);
  let tp = 0;
  let octets = 0;
  let sawDigit = false;
  for (const ch of text) {
    if (isDigit(ch)) {
      const current = out[tp] ?? 0;
      if (sawDigit && current === 0) return undefined;
      const next = current * 10 + Number(ch);
      if (next > 255) return undefined;
      out[tp] = next;
      if (!sawDigit) {
        octets += 1;
        if (octets > 4) return undefined;
        sawDigit = true;
      }
    } else if (ch === '.' && sawDigit) {
      if (octets === 4) return undefined;
      tp += 1;
      out[tp] = 0;
      sawDigit = false;
    } else {
      return undefined;
    }
  }
  return octets < 4 ? undefined : out;
}

/**
 * glibc's `inet_pton6` (resolv/inet_pton.c): eight groups of at most four hex digits, one `::`, an
 * IPv4 tail, and nothing else, so no `%scope`: a scoped hosts line is not one glibc reads (O-OS-3).
 */
export function inetPton6(text: string): Uint8Array | undefined {
  const out = new Uint8Array(16);
  const end = text.length;
  let i = 0;
  let tp = 0;
  let colonp = -1;
  if (end === 0) return undefined;
  if (text[0] === ':') {
    i = 1;
    if (i === end || text[i] !== ':') return undefined;
  }
  let curtok = i;
  let seen = 0;
  let val = 0;
  while (i < end) {
    const ch = text[i];
    i += 1;
    const digit = digitIn(ch, 16);
    if (digit >= 0) {
      if (seen === 4) return undefined;
      val = (val << 4) | digit;
      if (val > 0xffff) return undefined;
      seen += 1;
      continue;
    }
    if (ch === ':') {
      curtok = i;
      if (seen === 0) {
        if (colonp !== -1) return undefined;
        colonp = tp;
        continue;
      }
      if (i === end || tp + 2 > 16) return undefined;
      out[tp] = (val >> 8) & 0xff;
      out[tp + 1] = val & 0xff;
      tp += 2;
      seen = 0;
      val = 0;
      continue;
    }
    if (ch === '.' && tp + 4 <= 16) {
      const tail = inetPton4(text.slice(curtok));
      if (tail !== undefined) {
        out.set(tail, tp);
        tp += 4;
        seen = 0;
        break;
      }
    }
    return undefined;
  }
  if (seen > 0) {
    if (tp + 2 > 16) return undefined;
    out[tp] = (val >> 8) & 0xff;
    out[tp + 1] = val & 0xff;
    tp += 2;
  }
  if (colonp !== -1) {
    // `::` that would stand for no group at all.
    if (tp === 16) return undefined;
    const n = tp - colonp;
    out.copyWithin(16 - n, colonp, tp);
    out.fill(0, colonp, 16 - n);
    tp = 16;
  }
  return tp === 16 ? out : undefined;
}

/** An IPv6 address in its shortest form (RFC 5952), as c-ares takes a server. */
function formatV6(bytes: Uint8Array): string {
  const groups = Array.from(
    { length: 8 },
    (_, k) => ((bytes[2 * k] ?? 0) << 8) | (bytes[2 * k + 1] ?? 0),
  );
  let bestAt = -1;
  let bestLength = 1;
  for (let k = 0; k < 8;) {
    if (groups[k] !== 0) {
      k += 1;
      continue;
    }
    let j = k;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - k > bestLength) {
      bestAt = k;
      bestLength = j - k;
    }
    k = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestAt === -1) return hex.join(':');
  return `${hex.slice(0, bestAt).join(':')}::${hex.slice(bestAt + bestLength).join(':')}`;
}

// --- resolv.conf -------------------------------------------------------------------------------

export interface ResolverOptions {
  readonly ndots: number;
  /**
   * The seconds of the first server's try (`retrans`): at most 30, and at least 1, since send_dg
   * floors every try at 1 s (resolv/res_send.c, `if (seconds <= 0) seconds = 1`), so `timeout:0`
   * waits as `timeout:1` does.
   */
  readonly timeout: number;
  readonly attempts: number;
  readonly rotate: boolean;
  readonly edns0: boolean;
  readonly trustAd: boolean;
}

export interface ResolvConf {
  /** The servers glibc asks, in order: the first `MAXNS`, as c-ares takes them. */
  readonly servers: readonly string[];
  /** The search list as glibc holds it: `.` is the root (`root_on_list`). */
  readonly search: readonly string[];
  readonly searchFrom: 'search' | 'domain' | 'hostname' | 'none';
  readonly options: ResolverOptions;
}

/**
 * **The narrowings**: shapes glibc 2.28 and master read alike, in a way the check could follow,
 * that the check is off for all the same (decided 2026-10-19). Each name maps to what glibc does
 * with the shape instead, by glibc's source (resolv/res_init.c in 2.28 and master alike, unless
 * named otherwise):
 * - `no-server`: `res_vinit_1`, which adds 127.0.0.1 when `nameserver_list_size` is 0, and reads a
 *   resolv.conf that is not there as one with no lines;
 * - `blank-search`: `res_vinit_1`, `if ((*cp == '\0') || (*cp == '\n')) continue;` after `domain`
 *   or `search` and its blanks;
 * - `domain-words`: `res_vinit_1`, `domain`, which cuts the line at its first blank (`strpbrk`);
 * - `search-shape`: `search_list_add` and `domain_from_hostname`, which copy the text as written;
 * - `ndots-over-15`: `res_setoptions`, `if (i <= RES_MAXNDOTS) ... else ... = RES_MAXNDOTS`;
 * - `unreadable-as-absent`: nss/nss_files/files-XXX.c `internal_setent`, UNAVAIL for any failed
 *   `fopen` but EAGAIN, which the default `[UNAVAIL=continue]` passes to the next source as for a
 *   file not there; sysdeps/posix/getaddrinfo.c `gaiconf_init`, which takes its defaults for any
 *   failed `fopen`; and elf/rtld.c, which preloads nothing unless `access (preload_file, R_OK)`.
 */
export const NARROWINGS = {
  'no-server':
    'resolv.conf is absent or names no name server: glibc asks 127.0.0.1, the local host',
  'blank-search': 'a search or domain line names no domain: glibc skips the line',
  'domain-words': 'a domain line names more than one domain: glibc takes the first',
  'search-shape':
    'a search domain, or the hostname’s domain when it is searched, is not a lower-case name: glibc takes it as written',
  'ndots-over-15': 'ndots is above 15: glibc takes 15 (RES_MAXNDOTS)',
  'unreadable-as-absent':
    'the hosts file, gai.conf or /etc/ld.so.preload cannot be read: glibc reads it as a file that is not there',
} as const;
export type Narrowing = keyof typeof NARROWINGS;

/** A file the check reads, as it reads it: what it vouches on, or why it does not. */
export type Reading<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: string; readonly narrowing?: Narrowing };

const refuse = (
  why: string,
  narrowing?: Narrowing,
): { readonly ok: false; readonly why: string; readonly narrowing?: Narrowing } =>
  narrowing === undefined ? { ok: false, why } : { ok: false, why, narrowing };

/** The `options` words the check takes, each exactly, with what it sets. */
const FLAG_WORDS: ReadonlyMap<string, 'rotate' | 'edns0' | 'trustAd'> = new Map([
  ['rotate', 'rotate'],
  ['edns0', 'edns0'],
  ['trust-ad', 'trustAd'],
]);

/** `ndots:`, `timeout:` and `attempts:` with a decimal that fits an `int` (`atoi`, `strtol`). */
const NUMBER_OPTION = /^(ndots|timeout|attempts):(0|[1-9][0-9]{0,8})$/u;

/** A search domain the check takes: the root, or a lower-case name with no dot at either end. */
function isSearchDomain(word: string): boolean {
  return word === '.' || /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/u.test(word);
}

/** A `nameserver` address the check takes, as c-ares takes it: `inet_pton` takes no `%scope`. */
function serverAddress(word: string): string | undefined {
  if (inetPton4(word) !== undefined) return word;
  const v6 = inetPton6(word);
  return v6 === undefined ? undefined : formatV6(v6);
}

/**
 * resolv.conf, taken only where it has these lines, which glibc 2.28 and master read alike
 * (resolv/res_init.c `res_vinit_1`, `res_setoptions`; resolv/resolv_conf.c `update_from_conf`):
 * - **a blank line**, or one that **starts with `#` or `;`**: `MATCH` finds no keyword in the
 *   first, and the loop skips the others as comments;
 * - **`nameserver`** and one address: four decimal octets, or an IPv6 address with no `%scope`.
 *   2.28 reads the first by `__inet_aton`, which takes trailing blanks; master by
 *   `__inet_aton_exact` after it cuts the line at the first blank ("Ignore trailing contents");
 *   both read an IPv6 one by `inet_pton` after the same cut. The first `MAXNS` (3) are asked, so
 *   only they must differ;
 * - **`search`** with one or more domains, or **`domain`** with one, each `.` (the root) or a
 *   lower-case name of letters, digits and `-`, no dot at either end: the last such line wins
 *   (each clears the list, `search_list_clear`);
 * - **`options`** with words each exactly `ndots:N` (0 to 15), `timeout:N` (capped at
 *   `RES_MAXRETRANS`, 30, and held as at least 1, as send_dg floors each try), `attempts:N` (1 or
 *   more, capped at `RES_MAXRETRY`, 5), `rotate`, `edns0` or `trust-ad`, N in decimal with at most
 *   9 digits; a later word wins. `trust-ad` is a
 *   word 2.28 to 2.30 ignore, as they ignore any they do not know, and it sets the AD bit of a
 *   query and nothing else (glibc 2.31 NEWS), so either reading asks the same questions.
 *
 * A keyword starts its line and is followed by a blank (`MATCH`); blanks (space, tab) separate the
 * words and may end the line, where both readers skip them. Anything else is off, naming the first:
 * an unknown keyword (`sortlist`, `lookup`) or option word (`no-aaaa`, `strict-error`,
 * `single-request`, `use-vc`, `-rotate`, `rotatex`…), an indented line, a NUL or a CR anywhere, text
 * after a server's address, and no server at all (glibc then asks the local host). With no `search`
 * or `domain` line glibc searches the hostname's domain (`domain_from_hostname`), which must then
 * be a search domain the check takes too.
 *
 * Five of these refusals are narrowings, named on the refusal (`NARROWINGS`): no server
 * (`no-server`), a `search` or `domain` line with no domain (`blank-search`), a `domain` line with
 * more than one (`domain-words`), a search domain or the hostname's domain that is not one the
 * check takes (`search-shape`), and `ndots:` above 15 (`ndots-over-15`).
 */
export function readResolvConf(text: string, hostname: string): Reading<ResolvConf> {
  if (text.includes('\0')) return refuse('resolv.conf has a NUL byte, where glibc’s C strings end');
  if (text.includes('\r')) {
    return refuse('resolv.conf has a CR (a DOS line ending?), which glibc reads as part of a word');
  }
  const servers: string[] = [];
  let search: string[] = [];
  let searchFrom: ResolvConf['searchFrom'] = 'none';
  const options = {
    ndots: 1,
    timeout: DEFAULT_TIMEOUT,
    attempts: DEFAULT_ATTEMPTS,
    rotate: false,
    edns0: false,
    trustAd: false,
  };
  for (const [index, line] of text.split('\n').entries()) {
    if (/^[ \t]*$/u.test(line) || line.startsWith('#') || line.startsWith(';')) continue;
    const at = `resolv.conf line ${String(index + 1)}`;
    const match = /^(nameserver|search|domain|options)[ \t](.*)$/u.exec(line);
    if (match === null) {
      return refuse(
        `${at}, ${JSON.stringify(line)}, is no nameserver, search, domain or options line`,
      );
    }
    const keyword = match[1] ?? '';
    const words = (match[2] ?? '').split(/[ \t]+/u).filter((word) => word !== '');
    if (keyword === 'nameserver') {
      const address = words.length === 1 ? serverAddress(words[0] ?? '') : undefined;
      if (address === undefined) {
        return refuse(
          `${at}: a nameserver line names one IPv4 or IPv6 address, no scope, and nothing after it`,
        );
      }
      if (servers.length < MAXNS && servers.includes(address)) {
        return refuse(`${at}: name server ${address} is named twice`);
      }
      servers.push(address);
    } else if (keyword === 'options') {
      for (const word of words) {
        const flag = FLAG_WORDS.get(word);
        const number = NUMBER_OPTION.exec(word);
        const n = Number(number?.[2]);
        if (flag !== undefined) options[flag] = true;
        else if (number?.[1] === 'ndots' && n <= MAX_NDOTS) options.ndots = n;
        else if (number?.[1] === 'timeout') options.timeout = Math.max(1, Math.min(n, MAX_TIMEOUT));
        else if (number?.[1] === 'attempts' && n >= 1) options.attempts = Math.min(n, MAX_ATTEMPTS);
        else {
          return refuse(
            `${at}: options ${word} is not one the check vouches on`,
            number?.[1] === 'ndots' ? 'ndots-over-15' : undefined,
          );
        }
      }
    } else {
      const bad = words.find((word) => !isSearchDomain(word));
      if (words.length === 0 || (keyword === 'domain' && words.length > 1) || bad !== undefined) {
        return refuse(
          `${at}: a ${keyword} line names ${keyword === 'domain' ? 'one domain' : 'domains'}, each . or a lower-case name${bad === undefined ? '' : `, not ${JSON.stringify(bad)}`}`,
          words.length === 0
            ? 'blank-search'
            : keyword === 'domain' && words.length > 1
              ? 'domain-words'
              : 'search-shape',
        );
      }
      search = words;
      searchFrom = keyword === 'search' ? 'search' : 'domain';
    }
  }
  if (servers.length === 0) {
    return refuse('resolv.conf names no name server: glibc then asks the local host', 'no-server');
  }
  if (search.length === 0) {
    const domain = domainOf(hostname);
    if (domain !== null && !isSearchDomain(domain)) {
      return refuse(
        `the hostname’s domain, ${JSON.stringify(domain)}, which glibc searches, is no lower-case name`,
        'search-shape',
      );
    }
    if (domain !== null) {
      search = [domain];
      searchFrom = 'hostname';
    }
  }
  return { ok: true, value: { servers: servers.slice(0, MAXNS), search, searchFrom, options } };
}

/**
 * Whether gai.conf says `reload yes` (gai.conf(5); sysdeps/posix/getaddrinfo.c, `gaiconf_init`): the
 * last `reload` line wins, and only the word `yes` turns it on. Without it a process reads the file
 * once, at its first `getaddrinfo` with addresses to sort, and never again (D28).
 */
export function gaiReloads(text: string): boolean {
  let reload = false;
  for (const raw of text.split('\n')) {
    const words = (raw.split('#', 1)[0] ?? '').split(/[ \t\n\v\f\r]+/u).filter((w) => w !== '');
    if (words[0] === 'reload') reload = words[1] === 'yes';
  }
  return reload;
}

// --- nsswitch.conf -----------------------------------------------------------------------------

/** The `hosts:` lines the check is on with. */
export type HostsLine = 'files dns' | 'files dns myhostname' | 'files myhostname dns';
const HOSTS_LINES: readonly string[] = [
  'files dns',
  'files dns myhostname',
  'files myhostname dns',
];

/**
 * The database a line of nsswitch.conf may be for: leading blanks skipped, then the name up to a
 * blank, `:` or the line's end (`nss_getline` in nss/nsswitch.c to 2.32, `process_line` in
 * nss/nss_database.c from 2.33). 2.32 and older take no line that ends at the name; 2.33 and later
 * read the line with its newline, which `process_line` skips as a blank, so `hosts` alone is a
 * hosts line with no sources to them. Counted either way, it can only turn the check off.
 */
function databaseOf(line: string): string | undefined {
  let i = 0;
  while (isCSpace(line[i])) i += 1;
  const start = i;
  while (i < line.length && !isCSpace(line[i]) && line[i] !== ':') i += 1;
  return i === start ? undefined : line.slice(start, i);
}

/**
 * nsswitch.conf's `hosts:` line, taken only when there is exactly one and it is `hosts:` and then
 * `files dns`, `files dns myhostname` or `files myhostname dns`, blanks (space, tab) aside, and the
 * line ends in a newline. Both readers compare database names with `strcmp`, so a `Hosts:` line is
 * no hosts line to either; they part on the rest, and each of these turns the check off:
 * - **no file, or no hosts line**: glibc uses its built-in default;
 * - **two hosts lines**: 2.32 and older use the first (`__nss_database_lookup`), 2.33 and later
 *   the last (`process_line` overwrites);
 * - **the file's last line, with no newline**: from 2.33 `nss_database_reload_1` stops at the end of
 *   the file before it reads that line;
 * - **a `#`**, which ends the line to 2.32 and older (`nss_parse_file`) and starts more sources to
 *   2.33 and later; **an action group `[…]`**; **any other source**; **a `:` or blank before the
 *   colon**, which 2.32 and older read into the first source;
 * - **an action group on any other line**, a comment's included: from 2.33 glibc reads the file as
 *   a whole (`nss_database_reload_1`), and a line it cannot parse for any database it knows ends
 *   the read, so that no database has anything to ask. Only an action group can fail to parse
 *   (nss/nss_action_parse.c), and telling a good one from a bad one is not worth the risk.
 */
export function readNsswitch(text: string | null): Reading<HostsLine> {
  if (text === null) return refuse('nsswitch.conf is absent: glibc uses its built-in default');
  const lines = text.split('\n');
  const found = [...lines.entries()].filter(([, line]) => databaseOf(line) === 'hosts');
  const [first, second] = found;
  if (first === undefined)
    return refuse('nsswitch.conf has no hosts: line: glibc uses its built-in default');
  if (second !== undefined) {
    return refuse(
      'nsswitch.conf has two hosts: lines: glibc 2.32 and older read the first, 2.33 and later the last',
    );
  }
  const [index, line] = first;
  if (index === lines.length - 1) {
    return refuse(
      'nsswitch.conf’s hosts: line is its last, with no newline: glibc 2.33 and later never read it',
    );
  }
  const sources = /^[ \t]*hosts:(.*)$/su
    .exec(line)?.[1]
    ?.split(/[ \t]+/u)
    .filter((s) => s !== '');
  const other = sources?.find((source) => !['files', 'dns', 'myhostname'].includes(source));
  const why = line.includes('#')
    ? 'has a #'
    : line.includes('[')
      ? 'has an action group'
      : sources === undefined
        ? 'is not "hosts:" and then its sources'
        : other !== undefined
          ? `names ${JSON.stringify(other)}`
          : HOSTS_LINES.includes(sources.join(' '))
            ? undefined
            : `is "${sources.join(' ')}", not files dns, files dns myhostname or files myhostname dns`;
  if (why !== undefined || sources === undefined)
    return refuse(`nsswitch.conf’s hosts: line ${why ?? ''}`);
  // The hosts: line's own group is refused above, so a line found here is another's.
  const grouped = lines.findIndex((each) => each.includes('['));
  if (grouped !== -1) {
    return refuse(
      `nsswitch.conf line ${String(grouped + 1)} has an action group: from 2.33 glibc reads the file as a whole, and one it cannot parse leaves every database, hosts too, with nothing to ask (nss/nss_database.c process_line)`,
    );
  }
  return { ok: true, value: sources.join(' ') as HostsLine };
}

// --- the hosts file ----------------------------------------------------------------------------

export interface HostsAddresses {
  /**
   * Whether the file answers the name for family 4: an IPv4 line, or a `::1` or `::ffff:a.b.c.d`
   * line, which the backend maps to 127.0.0.1 or to a.b.c.d when asked for AF_INET.
   */
  readonly v4: boolean;
  /** Whether it answers the name for family 6: an IPv6 line. */
  readonly v6: boolean;
}

/** `IN6_IS_ADDR_LOOPBACK` or `IN6_IS_ADDR_V4MAPPED`: an IPv6 address files maps for AF_INET. */
function mappedForV4(bytes: Uint8Array): boolean {
  const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);
  const loopback = zeros(0, 15) && bytes[15] === 1;
  const v4Mapped = zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  return loopback || v4Mapped;
}

/**
 * The hosts file as glibc's `files` backend reads it (nss/nss_files/files-hosts.c, `LINE_PARSER`;
 * files-parse.c): leading blanks skipped, `#` ends a line anywhere, the first field the address and
 * every later one a name. The address by `inet_pton`, so a `%scope` or an `inet_aton` form makes the
 * line one glibc skips (O-OS-3). Names are kept as written but in lower case, trailing dot and all:
 * the backend compares with `strcasecmp`, so `printer.` is not `printer` (D17).
 *
 * A line is a C string: a NUL ends it. And a line that does not end in a newline, the file's last or
 * one with a NUL, and starts with blanks, is left out: from 2.32 `__nss_readline`
 * (nss/nss_readline.c) moves it over its blanks with `memmove (buf, p, strlen (p))`, which leaves
 * its last characters twice, so `  10.9.9.9 printer` is read as `printerer`.
 *
 * Asked for family 4, the backend parses the address as IPv4, and when that fails takes a `::1` line
 * as 127.0.0.1 and a `::ffff:a.b.c.d` line as a.b.c.d, and skips any other IPv6 line (`LINE_PARSER`,
 * `af == AF_INET`), so those two answer family 4 too. Families 0 and 6 read them as IPv6.
 */
export function hostsTable(text: string): Map<string, HostsAddresses> {
  const table = new Map<string, HostsAddresses>();
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const nul = raw.indexOf('\0');
    const line = nul === -1 ? raw : raw.slice(0, nul);
    const ended = nul === -1 && (index < lines.length - 1 || text.endsWith('\n'));
    if (!ended && isCSpace(line[0])) continue;
    const body = (line.split('#', 1)[0] ?? '').split(/[ \t\n\v\f\r]+/u).filter((w) => w !== '');
    const [address, ...names] = body;
    if (address === undefined) continue;
    const v4Line = inetPton4(address) !== undefined;
    const v6Bytes = v4Line ? undefined : inetPton6(address);
    const v6 = v6Bytes !== undefined;
    if (!v4Line && !v6) continue;
    const v4 = v4Line || (v6Bytes !== undefined && mappedForV4(v6Bytes));
    for (const name of names) {
      const key = asciiLower(name);
      const before = table.get(key);
      table.set(key, { v4: v4 || (before?.v4 ?? false), v6: v6 || (before?.v6 ?? false) });
    }
  }
  return table;
}

// --- the view and the classes ------------------------------------------------------------------

export type OffCode =
  | 'unloaded'
  | 'platform'
  | 'libc'
  | 'glibc'
  | 'unreadable'
  | 'resolv'
  | 'env'
  | 'nsswitch'
  | 'module'
  | 'nscd'
  | 'skew'
  | 'slow'
  | 'fault'
  | 'unbuilt';

/** Why the check is off: the first rule that failed. No name is walked, and none is `local`. */
export interface CheckOff {
  readonly code: OffCode;
  readonly why: string;
  /** When the shape is one glibc reads alike at every version, off on purpose (`NARROWINGS`). */
  readonly narrowing?: Narrowing;
}

/** What the policy read, and when the check is off, why. */
export interface PolicyView {
  readonly platform: string;
  readonly glibc: GlibcVersion | undefined;
  /** resolv.conf as the check reads it, when it has only lines the check takes. */
  readonly conf: ResolvConf | undefined;
  /** The hosts: line, when it is one the check takes. */
  readonly line: HostsLine | undefined;
  readonly hosts: ReadonlyMap<string, HostsAddresses>;
  readonly nscd: boolean;
  /** What `nssModuleLook` found for each module looked for. */
  readonly modules: ReadonlyMap<string, ModuleLook>;
  readonly gaiReload: boolean;
  readonly off: CheckOff | undefined;
}

/** What a view is built from. A file's text is null when it is absent, undefined when unreadable. */
export interface PolicyInputs {
  readonly platform: string;
  readonly glibc: string | null | undefined;
  readonly env: Environment;
  /** The hostname at load: glibc's search list when resolv.conf names none. */
  readonly hostname: string;
  readonly hosts: string | null | undefined;
  readonly resolvConf: string | null | undefined;
  readonly nsswitchConf: string | null | undefined;
  readonly gaiConf: string | null | undefined;
  readonly ldSoPreload: string | null | undefined;
  /** The error code of each file that could not be read, for the reason the check gives. */
  readonly codes?: Readonly<Partial<Record<SystemFileKey, string>>>;
  readonly nscd: boolean;
  readonly modules: ReadonlyMap<string, ModuleLook>;
  /** The first thing that moved since load (rule 6), which keeps the check off until restart. */
  readonly moved?: CheckOff;
  /** `hostsTable(hosts)`, when the caller kept it from an earlier build of the same text. */
  readonly hostsTable?: ReadonlyMap<string, HostsAddresses>;
}

/**
 * Rule 3: what in the environment changes glibc's lookups in a way the check does not read. That
 * includes what ld.so loads into the process before glibc (elf/rtld.c): a library named in
 * `LD_PRELOAD`, or an auditor in `LD_AUDIT`, may answer `getaddrinfo` itself. Each is none when
 * empty.
 */
export function environmentOff(env: Environment): CheckOff | undefined {
  for (const name of ['LOCALDOMAIN', 'RES_OPTIONS', 'HOSTALIASES']) {
    if (env[name] !== undefined) {
      return {
        code: 'env',
        why: `${name} is set in ms-probe’s environment, and glibc’s resolver reads it`,
      };
    }
  }
  // An empty LD_LIBRARY_PATH is none (elf/dl-load.c `_dl_init_paths`).
  if ((env['LD_LIBRARY_PATH'] ?? '') !== '') {
    return {
      code: 'env',
      why: 'LD_LIBRARY_PATH is set: the NSS modules glibc loads may not be the ones looked at',
    };
  }
  for (const name of ['LD_PRELOAD', 'LD_AUDIT']) {
    if ((env[name] ?? '') !== '') {
      return {
        code: 'env',
        why: `${name} is set in ms-probe’s environment: what ld.so loads with it may answer for glibc`,
      };
    }
  }
  return undefined;
}

/** The modules that are libc's own from 2.34 (`NSS_BUILT_IN_FROM`). */
const LIBC_MODULES: ReadonlySet<string> = new Set(['files', 'dns']);

/** The NSS modules a hosts: line needs installed at this glibc. */
export function modulesOf(line: HostsLine, glibc: GlibcVersion): readonly string[] {
  const builtIn = atLeast(glibc, NSS_BUILT_IN_FROM);
  return line.split(' ').filter((name) => !(builtIn && LIBC_MODULES.has(name)));
}

const unreadable = (path: string, code: string | undefined, narrowing?: Narrowing): CheckOff => ({
  code: 'unreadable',
  why: `${path} could not be read (${code ?? 'unknown'})`,
  ...(narrowing === undefined ? {} : { narrowing }),
});

/** A refusal as the reason the check is off, its narrowing kept. */
const offFor = (
  code: OffCode,
  reading: { readonly why: string; readonly narrowing?: Narrowing },
): CheckOff =>
  reading.narrowing === undefined
    ? { code, why: reading.why }
    : { code, why: reading.why, narrowing: reading.narrowing };

export function viewOf(inputs: PolicyInputs, files: SystemFiles = SYSTEM_FILES): PolicyView {
  const glibc = glibcVersionOf(inputs.glibc);
  const resolv =
    typeof inputs.resolvConf === 'string'
      ? readResolvConf(inputs.resolvConf, inputs.hostname)
      : refuse('resolv.conf is absent: glibc then asks the local host', 'no-server');
  const nss = inputs.nsswitchConf === undefined ? undefined : readNsswitch(inputs.nsswitchConf);
  const line = nss?.ok === true ? nss.value : undefined;
  const first = (): CheckOff | undefined => {
    if (inputs.platform !== 'linux') {
      return { code: 'platform', why: `the probe runs on ${inputs.platform}, not Linux` };
    }
    if (glibc === undefined) return { code: 'libc', why: 'the probe’s C library is not glibc' };
    if (!atLeast(glibc, GLIBC_FLOOR) || atLeast(glibc, [GLIBC_CEILING[0], GLIBC_CEILING[1] + 1])) {
      return {
        code: 'glibc',
        why: `glibc ${glibc.join('.')} is outside ${GLIBC_FLOOR.join('.')} to ${GLIBC_CEILING.join('.')}, the versions the check has been read against`,
      };
    }
    const codes = inputs.codes ?? {};
    if (inputs.resolvConf === undefined) return unreadable(files.resolvConf, codes.resolvConf);
    if (!resolv.ok) return offFor('resolv', resolv);
    const env = environmentOff(inputs.env);
    if (env !== undefined) return env;
    if (inputs.ldSoPreload === undefined) {
      return unreadable(files.ldSoPreload, codes.ldSoPreload, 'unreadable-as-absent');
    }
    if (inputs.ldSoPreload !== null && inputs.ldSoPreload !== '') {
      return {
        code: 'env',
        why: `${files.ldSoPreload} is not empty: ld.so loads what it names into ms-probe before glibc, and it may answer for glibc`,
      };
    }
    if (nss === undefined) return unreadable(files.nsswitchConf, codes.nsswitchConf);
    if (!nss.ok) return offFor('nsswitch', nss);
    for (const name of modulesOf(nss.value, glibc)) {
      const look = inputs.modules.get(name);
      if (look?.state === 'installed') continue;
      return {
        code: 'module',
        why:
          look?.state === 'unknown'
            ? look.why
            : `glibc cannot load libnss_${name}.so.2, so ${name} answers nothing (nss/nss_module.c module_load)`,
      };
    }
    if (inputs.nscd) return { code: 'nscd', why: `nscd is running (${files.nscdSocket})` };
    if (inputs.hosts === undefined) {
      return unreadable(files.hosts, codes.hosts, 'unreadable-as-absent');
    }
    if (inputs.gaiConf === undefined) {
      return unreadable(files.gaiConf, codes.gaiConf, 'unreadable-as-absent');
    }
    return inputs.moved;
  };
  return {
    platform: inputs.platform,
    glibc,
    conf: resolv.ok ? resolv.value : undefined,
    line,
    hosts: inputs.hostsTable ?? hostsTable(inputs.hosts ?? ''),
    nscd: inputs.nscd,
    modules: inputs.modules,
    gaiReload: gaiReloads(inputs.gaiConf ?? ''),
    off: first(),
  };
}

export type CannotVouch =
  'not-a-dns-name' | 'systemd-name' | 'localhost' | 'numeric-family-6' | 'candidate';

/**
 * Where the policy sends a name (§1.3 rows 3, 4, 5 in part, and 8). `local`'s `refused`: a name
 * glibc's `dns` refuses unasked, under a line whose every other source is local.
 */
export type NameClass =
  | { readonly kind: 'local'; readonly via: 'hosts' | 'numeric' | 'myhostname' | 'refused' }
  | { readonly kind: 'cannotVouch'; readonly reason: CannotVouch }
  | { readonly kind: 'off'; readonly reason: CheckOff }
  | {
      readonly kind: 'walk';
      readonly candidates: readonly string[];
      readonly types: readonly QType[];
    };

const DNS_CHARACTERS = /^[a-z0-9._-]+$/u;

/** A name glibc would put on the wire as it is: `[a-z0-9._-]`, labels of 1–63, at most 253. */
export function isDnsName(host: string): boolean {
  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  if (bare === '' || bare.length > 253 || !DNS_CHARACTERS.test(bare)) return false;
  return bare.split('.').every((label) => label !== '' && label.length <= 63);
}

const withoutDot = (host: string): string => (host.endsWith('.') ? host.slice(0, -1) : host);

/**
 * systemd's `is_localhost` (src/basic/hostname-util.c): `localhost`, `localhost.localdomain`, and
 * any name under either, which nss-myhostname and resolved answer themselves.
 */
const isLocalhost = (bare: string): boolean =>
  bare === 'localhost' ||
  bare.endsWith('.localhost') ||
  bare === 'localhost.localdomain' ||
  bare.endsWith('.localhost.localdomain');

/**
 * Row 3: a name whose lookup goes somewhere the walk does not model, or that glibc may settle in a
 * way the policy does not pin. Checked before `local`, so that `myhostname`'s maybes are never
 * `local` (O-OS-7).
 */
function cannotVouch(host: string, family: Family): CannotVouch | undefined {
  if (!isDnsName(host)) return 'not-a-dns-name';
  const bare = withoutDot(host);
  if (SYSTEMD_NAMES.has(bare)) return 'systemd-name';
  if (isLocalhost(bare)) return 'localhost';
  if (family === 6 && inetAton(host) !== undefined) return 'numeric-family-6';
  return undefined;
}

/**
 * Row 4's hosts rule: the file gives the name an address of the family asked (any for family 0).
 * Every hosts: line the check takes asks `files` first, with its default `[SUCCESS=return]`.
 */
function inHosts(host: string, family: Family, view: PolicyView): boolean {
  const entry = view.hosts.get(host);
  if (entry === undefined) return false;
  return family === 0 ? entry.v4 || entry.v6 : family === 4 ? entry.v4 : entry.v6;
}

/**
 * Row 4's `myhostname` rule, under `files myhostname dns` only: in the other two lines DNS is asked
 * first. nss-myhostname answers the hostname exactly as `gethostname` gives it, or with one trailing
 * dot (`streq`, systemd src/nss-myhostname/nss-myhostname.c), and the asked name is in lower case,
 * so a mixed-case hostname is not answered (O-OS-7). It is read at each ask. Families 0 and 4 only:
 * for family 6 on a host without IPv6, newer systemd answers NOTFOUND and glibc goes on to DNS,
 * which the policy does not pin.
 */
function byMyhostname(host: string, family: Family, line: HostsLine, hostname: string): boolean {
  if (line !== 'files myhostname dns' || family === 6 || hostname === '') return false;
  return host === hostname || host === `${hostname}.`;
}

/**
 * Row 4, family 4: a name glibc refuses before nscd and NSS. For AF_INET without AI_CANONNAME,
 * `getaddrinfo` asks `__gethostbyname2_r` (`try_simple_gethostbyname` in nss/getaddrinfo.c, the same
 * block of `gaih_inet` before), whose `__nss_hostname_digits_dots` (nss/digits_dots.c) answers
 * HOST_NOT_FOUND for a name of digits and dots that begins with a digit, does not end in a dot and
 * is no `inet_aton` form: `1.2.3.256`, `08.1`, `4294967296`.
 */
function refusedDigitsAndDots(host: string): boolean {
  return /^[0-9][0-9.]*$/u.test(host) && !host.endsWith('.') && inetAton(host) === undefined;
}

/**
 * The candidates `__res_context_search` (resolv/res_query.c) asks for a name, in order, while each
 * answers NXDOMAIN or NODATA: a trailing dot means the name as it is and only that; with at least
 * `ndots` dots the name as it is first; then each search entry, `.` the root (`root_on_list`, the
 * name again); then the name as it is, unless already asked or the root was on the list. Each
 * without its trailing dot.
 */
export function searchCandidates(host: string, search: readonly string[], ndots: number): string[] {
  const dots = host.split('.').length - 1;
  const trailing = host.endsWith('.');
  const bare = withoutDot(host);
  const asked: string[] = [];
  let triedAsIs = false;
  let rootOnList = false;
  if (dots >= ndots || trailing) {
    asked.push(bare);
    if (trailing) return asked;
    triedAsIs = true;
  }
  for (const domain of search) {
    if (domain === '.') {
      rootOnList = true;
      asked.push(bare);
    } else {
      asked.push(`${bare}.${domain}`);
    }
  }
  if (!triedAsIs && !rootOnList) asked.push(bare);
  return asked;
}

/**
 * The names the walk asks for a name, in glibc's order (§1.4). Undefined when one of them is too
 * long to be a name glibc could ask: glibc gives up on it unasked, which the walk does not model, so
 * the name is unvouched.
 */
export function candidatesOf(host: string, conf: ResolvConf): readonly string[] | undefined {
  const asked = searchCandidates(host, conf.search, conf.options.ndots);
  return asked.every((name) => isDnsName(name)) ? asked : undefined;
}

/** The types `getaddrinfo` asks: A for family 4, AAAA for 6, both for 0, A first. */
export function typesFor(family: Family): readonly QType[] {
  if (family === 4) return ['A'];
  if (family === 6) return ['AAAA'];
  return ['A', 'AAAA'];
}

const NOT_LOADED: CheckOff = { code: 'unloaded', why: 'the system’s files have not been read yet' };

/**
 * Whether this build has the name check (`P-432` S6 built it, `dns-check.ts`). A build without it
 * had the check off whatever the system's shape, and asked every name glibc does not answer from
 * local files in the lookup helper; `checkOn`, the description logged at start and Probe Health's
 * `nameCheckOnSeconds` said so. A test may still build a policy without it (`checkBuilt`).
 */
export const NAME_CHECK_BUILT = true;

/** Why the check is off in a build without it (`NAME_CHECK_BUILT`). */
export const CHECK_NOT_BUILT: CheckOff = {
  code: 'unbuilt',
  why:
    'the name check is not in this build: every name glibc does not answer from local files is ' +
    'asked in the lookup helper',
};

/**
 * Where the policy sends a name, asked as the resolver keys it (trimmed, lower case, a trailing dot
 * kept), for a family. While the check is off, nowhere it vouches for. What `getaddrinfo` settles
 * before NSS and nscd comes first: an `inet_aton` form (sysdeps/posix/getaddrinfo.c,
 * `text_to_binary_address`), and for family 4 a name `__nss_hostname_digits_dots` refuses.
 */
export function classifyName(
  host: string,
  family: Family,
  view: PolicyView,
  hostname: string,
): NameClass {
  const { conf, line, glibc } = view;
  if (view.off !== undefined || conf === undefined || line === undefined || glibc === undefined) {
    return { kind: 'off', reason: view.off ?? NOT_LOADED };
  }
  if (family !== 6 && inetAton(host) !== undefined) return { kind: 'local', via: 'numeric' };
  if (family === 4 && refusedDigitsAndDots(host)) return { kind: 'local', via: 'numeric' };
  const unvouched = cannotVouch(host, family);
  const listed = inHosts(host, family, view);
  if (listed && (unvouched === undefined || unvouched === 'localhost')) {
    return { kind: 'local', via: 'hosts' };
  }
  if (unvouched !== undefined) return { kind: 'cannotVouch', reason: unvouched };
  if (byMyhostname(host, family, line, hostname)) return { kind: 'local', via: 'myhostname' };
  if (host.startsWith('-') && atLeast(glibc, DNS_CHECKS_NAMES_FROM)) {
    return { kind: 'local', via: 'refused' };
  }
  const candidates = candidatesOf(host, conf);
  if (candidates === undefined) return { kind: 'cannotVouch', reason: 'candidate' };
  return { kind: 'walk', candidates, types: typesFor(family) };
}

// --- the policy --------------------------------------------------------------------------------

/** What the lookup helper's `ready` must echo (D28): a child that read otherwise is skewed. */
export interface PolicySnapshot {
  readonly node: string;
  readonly glibc: string | null;
  /**
   * Each file this process's glibc reads once, by path: its digest at load, by `digestOf`'s
   * contract (sha256 of its bytes, `absent`, or `unreadable:<code>`).
   */
  readonly digests: Readonly<Record<string, string>>;
}

/** What one look of the watch moved. */
export interface PolicyChange {
  /** The hosts file's new text, now followed. */
  readonly applied: readonly string[];
  /** Files whose contents moved since load, turning the check off until restart (rule 6). */
  readonly moved: readonly string[];
  /** The nscd socket came or went. */
  readonly nscdChanged: boolean;
}

export interface PolicyDescription {
  /** On only in a build with the check (`NAME_CHECK_BUILT`) and a shape it takes. */
  readonly check: 'on' | 'off';
  /** Why it is off: `CHECK_NOT_BUILT` in a build without it, else the shape's own reason. */
  readonly off: CheckOff | undefined;
  /** What the system's shape says of the check: the first rule it fails, or none. */
  readonly shapeOff: CheckOff | undefined;
  readonly platform: string;
  readonly glibc: string | null;
  readonly servers: readonly string[];
  readonly search: readonly string[];
  readonly searchFrom: ResolvConf['searchFrom'] | undefined;
  readonly options: ResolverOptions | undefined;
  readonly hostsLine: HostsLine | undefined;
  readonly nscd: boolean;
  readonly modules: readonly string[];
  readonly readOnce: readonly string[];
  readonly skewed: boolean;
}

/** The system's name policy, as the gate's routing reads it (§1.2–§1.4, §1.12, D28). */
export interface SystemNamePolicy {
  /**
   * Reads resolv.conf, nsswitch.conf, gai.conf, /etc/ld.so.preload, the environment, glibc's
   * version, the nscd socket and the NSS modules installed, and the hosts file unless its text is
   * given (the resolver's own reading, L-N3). What the watch told before it ends is compared with
   * what it read, as a look would. Never rejects, and never takes longer than `POLICY_LOAD_MS`:
   * what fails turns the check off until restart (`fault`), and what takes longer turns it off for
   * now (`slow`), until it ends and builds its view, or until a look finds it still reading
   * (`fault`).
   */
  load(options?: { readonly hosts?: string }): Promise<void>;
  /**
   * One look of the resolver's watch (`watch.onLook`): the files it read anew, as it read them. The
   * hosts file is followed; any other file that moved turns the check off until restart. The nscd
   * socket and the modules are looked for. Never rejects, and never takes longer than
   * `POLICY_LOOK_MS`: a look that does is let go, and the check is off for now (`slow`). The next
   * look drops what it found and looks again if it has ended, and turns the check off until restart
   * (`fault`) if it has not.
   */
  looked(readings: readonly WatchedReading[]): Promise<PolicyChange>;
  classify(host: string, family: Family): NameClass;
  view(): PolicyView;
  /** Whether the check is on: built (`NAME_CHECK_BUILT`), and the shape one it takes. */
  checkOn(): boolean;
  snapshot(): PolicySnapshot;
  /** A read-once file now says otherwise than this process's glibc read: a new helper would differ. */
  skewed(): boolean;
  /**
   * The files the gate adds to the resolver's watch (§1.12): gai.conf and /etc/ld.so.preload,
   * beyond the hosts file, resolv.conf and nsswitch.conf it watches already
   * (`systemResolverFiles`, `P-438`). Only those, so that a change to any file reaches the policy
   * by one path, the resolver's own look.
   */
  watchedFiles(): readonly string[];
  describe(): PolicyDescription;
}

export interface GlibcNamePolicyOptions {
  readonly logger: Logger;
  readonly files?: SystemFiles;
  readonly env?: Environment;
  readonly platform?: string;
  /** glibc's runtime version, null off glibc. `glibcRuntime`'s unless a test hands one in. */
  readonly glibcVersion?: () => string | null;
  readonly nodeVersion?: string;
  readonly hostname?: () => string;
  /**
   * A file's text, null when it is absent and undefined when it cannot be read (digested as
   * `unreadable:unknown`); a text is digested as its UTF-8 bytes. Unless a test hands one in, the
   * file's bytes are read and digested as read, and a failed read by its error's code.
   */
  readonly readText?: (path: string) => Promise<string | null | undefined>;
  readonly socketExists?: (path: string) => Promise<boolean>;
  /** Whether glibc would load `libnss_<name>.so.2`: `nssModuleLook` unless a test says. */
  readonly moduleLook?: (name: string) => Promise<ModuleLook>;
  /** How long a look may take: `POLICY_LOOK_MS` unless a test says. */
  readonly lookMs?: number;
  /** How long a load may take: `POLICY_LOAD_MS` unless a test says. */
  readonly loadMs?: number;
  /** Whether the check is built: `NAME_CHECK_BUILT` unless a test says. */
  readonly checkBuilt?: boolean;
}

type FileKey = SystemFileKey;
const FILE_KEYS: readonly FileKey[] = [
  'hosts',
  'resolvConf',
  'nsswitchConf',
  'gaiConf',
  'ldSoPreload',
];

/** What one look, or what the watch read during load, did to the files. */
interface FileChange {
  readonly applied: string[];
  readonly moved: string[];
}

const noChange = (): PolicyChange => ({ applied: [], moved: [], nscdChanged: false });

/** A digest as a move's message says it: `absent`, `unreadable (<code>)`, or the contents'. */
function digestSaid(digest: string): string {
  if (digest === DIGEST_ABSENT) return 'absent';
  const code = codeOfDigest(digest);
  if (code !== undefined) return `unreadable (${code})`;
  return `contents sha256:${digest.slice(0, 12)}`;
}

/** The error code an `unreadable:<code>` digest carries, or undefined for any other digest. */
function codeOfDigest(digest: string): string | undefined {
  const prefix = unreadableDigest('');
  return digest.startsWith(prefix) ? digest.slice(prefix.length) : undefined;
}

interface FileReading {
  /** null when the file is absent, undefined when it cannot be read. */
  readonly text: string | null | undefined;
  readonly digest: string;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A system file as the policy reads it: its bytes, decoded as UTF-8 and digested as read. */
async function readSystemFile(path: string): Promise<FileReading> {
  try {
    const bytes = await readFile(path);
    return { text: bytes.toString('utf8'), digest: digestOf(bytes) };
  } catch (error: unknown) {
    return { text: codeOf(error) === 'ENOENT' ? null : undefined, digest: digestOfError(error) };
  }
}

/** Whether a socket is there. One that cannot be looked at is taken to be, which turns the check off. */
async function socketExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch (error: unknown) {
    const code = codeOf(error);
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** Where a Linux build keeps its libraries, by Node's `process.arch`, and its ELF `e_machine`. */
const LIBRARY_LAYOUT: Readonly<
  Record<string, { readonly triplet: string; readonly machine: number }>
> = {
  x64: { triplet: 'x86_64-linux-gnu', machine: 62 },
  arm64: { triplet: 'aarch64-linux-gnu', machine: 183 },
};

/** Whether the file at `path` is a 64-bit little-endian ELF object for `machine`. */
async function isElfFor(path: string, machine: number): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return false;
  }
  try {
    // A file shorter than the header leaves the rest zero, which is no machine.
    const head = Buffer.alloc(20);
    await handle.read(head, 0, 20, 0);
    return (
      head.readUInt32BE(0) === 0x7f454c46 &&
      head[4] === 2 &&
      head[5] === 1 &&
      head.readUInt16LE(18) === machine
    );
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** Whether glibc can load an NSS module, as far as can be told (`nssModuleLook`). */
export type ModuleLook =
  { readonly state: 'installed' | 'absent' } | { readonly state: 'unknown'; readonly why: string };

/**
 * Whether glibc would load the NSS module `name`: `module_load` (nss/nss_module.c; `nss_load_library`
 * in nss/nsswitch.c before 2.33) dlopens `libnss_<name>.so.2`, and one it cannot is UNAVAIL. With
 * `LD_LIBRARY_PATH` empty, which the check requires (`environmentOff`), the loader looks where
 * /etc/ld.so.cache says, then in its standard directories for this architecture, on the two layouts
 * there are: Debian's multiarch `/lib/<triplet>`, `/usr/lib/<triplet>`, `/lib` and `/usr/lib`, where
 * `/usr/lib/<triplet>` exists; else `/lib64` and `/usr/lib64`.
 *
 * Installed: an ELF object for this machine in one of the standard directories. Absent: in none of
 * them, and an ld.so.cache that does not name the file, or none. Anything else cannot be told short
 * of the loader's own search, and is `unknown`: the cache naming the file (somewhere else, then) or
 * unreadable, or an architecture whose directories the policy does not know.
 */
export async function nssModuleLook(
  name: string,
  where: { readonly arch?: string; readonly root?: string } = {},
): Promise<ModuleLook> {
  const arch = where.arch ?? process.arch;
  const layout = LIBRARY_LAYOUT[arch];
  const file = `libnss_${name}.so.2`;
  if (layout === undefined) {
    return { state: 'unknown', why: `where the loader looks for ${file} on ${arch} is not known` };
  }
  const root = where.root ?? '/';
  let multiarch = false;
  try {
    multiarch = (await stat(join(root, 'usr/lib', layout.triplet))).isDirectory();
  } catch {
    multiarch = false;
  }
  const dirs = multiarch
    ? [`/lib/${layout.triplet}`, `/usr/lib/${layout.triplet}`, '/lib', '/usr/lib']
    : ['/lib64', '/usr/lib64'];
  for (const dir of dirs) {
    if (await isElfFor(join(root, dir, file), layout.machine)) return { state: 'installed' };
  }
  const missing = `${file} is in none of ${dirs.join(', ')}`;
  let cache: Buffer;
  try {
    cache = await readFile(join(root, 'etc/ld.so.cache'));
  } catch (error: unknown) {
    if (codeOf(error) === 'ENOENT') return { state: 'absent' };
    return { state: 'unknown', why: `${missing}, and /etc/ld.so.cache could not be read` };
  }
  if (cache.includes(`${file}\0`)) {
    return { state: 'unknown', why: `${missing}, and /etc/ld.so.cache names it` };
  }
  return { state: 'absent' };
}

/** The domain glibc's `domain_from_hostname` takes from a hostname: after its first dot, if any. */
function domainOf(hostname: string): string | null {
  const dot = hostname.indexOf('.');
  return dot === -1 ? null : hostname.slice(dot + 1);
}

const UNREAD: FileReading = { text: null, digest: DIGEST_ABSENT };

/**
 * The policy for glibc on Linux, and for every other platform the same reading with the check off.
 *
 * **What it follows.** Only the hosts file, which glibc's `files` module opens at every lookup
 * (nss/nss_files/files-XXX.c `internal_setent`). Everything else is what it read at load, and when
 * any of it moves the check is off until ms-probe restarts (`skew`), the first move named, so that
 * Probe Health's time with the check on stops: the digest of resolv.conf, nsswitch.conf, gai.conf
 * or /etc/ld.so.preload as the watch reads it, absent and unreadable included, the move naming what
 * it was and what it is; the hostname's domain while the search list
 * is the hostname's; the state of a module the hosts: line needs. By contents, never by inode or
 * times: glibc re-reads resolv.conf and nsswitch.conf when their inode, size or times move
 * (io/file_change_detection.c `__file_is_unchanged`), and on some builds not on every thread (bug
 * 31476), so when it has re-read one cannot be known from here. The same contents give the same
 * answers whether it has or not, and any other contents turn the check off. What the check cannot
 * see is a file changed and put back between two looks.
 *
 * **The read-once files (D28).** glibc reads gai.conf once per process unless it says `reload yes`,
 * and nsswitch.conf below 2.33, and ld.so reads /etc/ld.so.preload as the process starts:
 * `snapshot()` carries their digests at load for the helper's `ready`, and `skewed()` says a
 * helper started now would read otherwise.
 *
 * **nscd** is looked for at every look, and followed.
 *
 * **Bounded.** A load that has not ended within `POLICY_LOAD_MS`, or a look within
 * `POLICY_LOOK_MS`, turns the check off for now (`slow`) and is no longer waited on. A bound passed
 * is not yet a hang, since one stall of the event loop can pass it: a load that ends later builds
 * its view, and a look that ends later has what it found dropped, the next look looking again.
 * Only one the next look finds still not ended turns the check off until restart (`fault`). A look
 * the watch makes before load has read is kept and compared when it has, since the resolver tells
 * each reading once.
 */
export class GlibcNamePolicy implements SystemNamePolicy {
  readonly #logger: Logger;
  readonly #files: SystemFiles;
  readonly #env: Environment;
  readonly #platform: string;
  readonly #glibcVersion: () => string | null;
  readonly #nodeVersion: string;
  readonly #hostname: () => string;
  readonly #readText: ((path: string) => Promise<string | null | undefined>) | undefined;
  readonly #socketExists: (path: string) => Promise<boolean>;
  readonly #moduleLook: (name: string) => Promise<ModuleLook>;
  readonly #lookMs: number;
  readonly #loadMs: number;
  readonly #checkBuilt: boolean;
  #loaded = false;
  /** A load or look past its bound, no longer waited on; `settled` once it has ended. */
  #late: { readonly what: 'load' | 'look'; readonly ms: number; settled: boolean } | undefined;
  /** Moved on when a load or look passes its bound: a look that ends later drops what it found. */
  #generation = 0;
  /** What the watch read before load had, the latest of each file (`looked`). */
  readonly #early = new Map<string, WatchedReading>();
  #glibc: string | null = null;
  /** What load read of each file. */
  readonly #atLoad: Record<FileKey, FileReading> = {
    hosts: UNREAD,
    resolvConf: UNREAD,
    nsswitchConf: UNREAD,
    gaiConf: UNREAD,
    ldSoPreload: UNREAD,
  };
  /** The hosts file as now followed. */
  #hosts: FileReading = UNREAD;
  /** Each file's digest as last read. */
  readonly #latest: Record<FileKey, string> = {
    hosts: DIGEST_ABSENT,
    resolvConf: DIGEST_ABSENT,
    nsswitchConf: DIGEST_ABSENT,
    gaiConf: DIGEST_ABSENT,
    ldSoPreload: DIGEST_ABSENT,
  };
  #loadHostname = '';
  #nscd = false;
  #modules: ReadonlyMap<string, ModuleLook> = new Map();
  /** The first thing that moved since load, or the policy's own failure: off until restart. */
  #moved: CheckOff | undefined;
  #hostsTable:
    | {
        readonly text: string | null | undefined;
        readonly table: ReadonlyMap<string, HostsAddresses>;
      }
    | undefined;
  #view: PolicyView;

  constructor(options: GlibcNamePolicyOptions) {
    this.#logger = options.logger.child({ component: 'system-names' });
    this.#files = options.files ?? SYSTEM_FILES;
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#glibcVersion = options.glibcVersion ?? glibcRuntime;
    this.#nodeVersion = options.nodeVersion ?? process.version;
    this.#hostname = options.hostname ?? osHostname;
    this.#readText = options.readText;
    this.#socketExists = options.socketExists ?? socketExists;
    this.#moduleLook = options.moduleLook ?? ((name) => nssModuleLook(name));
    this.#lookMs = options.lookMs ?? POLICY_LOOK_MS;
    this.#loadMs = options.loadMs ?? POLICY_LOAD_MS;
    this.#checkBuilt = options.checkBuilt ?? NAME_CHECK_BUILT;
    this.#view = this.#offView(NOT_LOADED);
  }

  async load(options: { readonly hosts?: string } = {}): Promise<void> {
    await this.#bounded('load', this.#loadMs, () => this.#load(options));
  }

  async looked(readings: readonly WatchedReading[]): Promise<PolicyChange> {
    // Off until restart already: no look to wait on, and none to pile up behind one that hangs.
    if (this.#moved?.code === 'fault') return noChange();
    const late = this.#late;
    if (late !== undefined) {
      if (!late.settled) {
        // Past its bound, and not ended by the next look either: a hang, not a stall.
        this.#fail(
          new Error(
            `a ${late.what} of the system’s name settings did not end within ${String(late.ms)} ms, nor by the next look`,
          ),
        );
        return noChange();
      }
      // Ended since, so it was slow, not hung: what a look found is dropped (`#look`), and this
      // look looks again from the view as it stands, which can turn the check back on.
      this.#late = undefined;
      this.#view = this.#build();
    }
    if (!this.#loaded) {
      // Kept, the latest of each file, and compared when load has read (`#load`): the resolver
      // tells a reading once, so one dropped here would never come again.
      for (const reading of readings) this.#early.set(reading.file, reading);
      return noChange();
    }
    return (await this.#bounded('look', this.#lookMs, () => this.#look(readings))) ?? noChange();
  }

  async #load(options: { readonly hosts?: string }): Promise<void> {
    try {
      this.#glibc = this.#glibcVersion();
      const given = options.hosts;
      const [hosts, resolvConf, nsswitchConf, gaiConf, ldSoPreload, nscd, modules] =
        await Promise.all([
          given === undefined
            ? this.#read(this.#files.hosts)
            : { text: given, digest: digestOf(given) },
          this.#read(this.#files.resolvConf),
          this.#read(this.#files.nsswitchConf),
          this.#read(this.#files.gaiConf),
          this.#read(this.#files.ldSoPreload),
          this.#socketExists(this.#files.nscdSocket),
          this.#findModules(),
        ]);
      const read: Record<FileKey, FileReading> = {
        hosts,
        resolvConf,
        nsswitchConf,
        gaiConf,
        ldSoPreload,
      };
      for (const key of FILE_KEYS) {
        this.#atLoad[key] = read[key];
        this.#latest[key] = read[key].digest;
      }
      this.#hosts = hosts;
      this.#nscd = nscd;
      this.#modules = modules;
      this.#loadHostname = this.#hostname();
      this.#loaded = true;
      // What the watch read while load was reading, or before: put through a look's comparison
      // with what load read, so that a file that moved in between is a move.
      const change: FileChange = { applied: [], moved: [] };
      for (const reading of this.#early.values()) this.#take(reading, change);
      this.#early.clear();
      this.#view = this.#build();
    } catch (error: unknown) {
      this.#fail(error);
    }
  }

  async #look(readings: readonly WatchedReading[]): Promise<PolicyChange> {
    const change: FileChange = { applied: [], moved: [] };
    const { applied, moved } = change;
    const generation = this.#generation;
    try {
      const before = this.#moved;
      for (const reading of readings) this.#take(reading, change);
      const conf = this.#view.conf;
      const domain = domainOf(this.#hostname());
      const from = domainOf(this.#loadHostname);
      if ((conf?.searchFrom === 'hostname' || conf?.searchFrom === 'none') && domain !== from) {
        this.#move(
          `the hostname’s domain moved from ${String(from)} to ${String(domain)} with no search list in resolv.conf: which glibc searches is not known until ms-probe restarts`,
        );
      }
      // Rebuilt before the looks below are awaited, so that no lookup is classed by what the
      // resolver has just let go (PWH-4).
      if (applied.length > 0 || this.#moved !== before) this.#view = this.#build();
      const [nscd, modules] = await Promise.all([
        this.#socketExists(this.#files.nscdSocket),
        this.#findModules(),
      ]);
      // Past its bound and let go: what it found is dropped, and the next look looks again.
      if (generation !== this.#generation) return { applied, moved, nscdChanged: false };
      const nscdChanged = nscd !== this.#nscd;
      this.#nscd = nscd;
      const line = this.#view.line;
      const glibc = this.#view.glibc;
      if (line !== undefined && glibc !== undefined) {
        for (const name of modulesOf(line, glibc)) {
          if (modules.get(name)?.state !== this.#modules.get(name)?.state) {
            this.#move(
              `libnss_${name}.so.2 changed since ms-probe started, from ${this.#modules.get(name)?.state ?? 'not looked for'} to ${modules.get(name)?.state ?? 'not looked for'}: the check is off until ms-probe restarts`,
            );
          }
        }
      }
      if (nscdChanged || this.#moved !== before) this.#view = this.#build();
      return { applied, moved, nscdChanged };
    } catch (error: unknown) {
      // A look let go that fails later is dropped like any other end it comes to.
      if (generation === this.#generation) this.#fail(error);
      return { applied, moved, nscdChanged: false };
    }
  }

  classify(host: string, family: Family): NameClass {
    return classifyName(host, family, this.#view, this.#hostname());
  }

  view(): PolicyView {
    return this.#view;
  }

  checkOn(): boolean {
    return this.#checkBuilt && this.#view.off === undefined;
  }

  snapshot(): PolicySnapshot {
    const digests: Record<string, string> = {};
    for (const key of FILE_KEYS) {
      if (this.#readOnce(key)) digests[this.#files[key]] = this.#atLoad[key].digest;
    }
    return { node: this.#nodeVersion, glibc: this.#glibc, digests };
  }

  skewed(): boolean {
    return FILE_KEYS.some(
      (key) => this.#readOnce(key) && this.#latest[key] !== this.#atLoad[key].digest,
    );
  }

  watchedFiles(): readonly string[] {
    return [this.#files.gaiConf, this.#files.ldSoPreload];
  }

  describe(): PolicyDescription {
    const view = this.#view;
    return {
      check: this.checkOn() ? 'on' : 'off',
      off: this.#checkBuilt ? view.off : CHECK_NOT_BUILT,
      shapeOff: view.off,
      platform: view.platform,
      glibc: this.#glibc,
      servers: view.conf?.servers ?? [],
      search: view.conf?.search ?? [],
      searchFrom: view.conf?.searchFrom,
      options: view.conf?.options,
      hostsLine: view.line,
      nscd: view.nscd,
      modules: [...view.modules]
        .filter(([, look]) => look.state === 'installed')
        .map(([name]) => name)
        .sort(),
      readOnce: FILE_KEYS.filter((key) => this.#readOnce(key)).map((key) => this.#files[key]),
      skewed: this.skewed(),
    };
  }

  /** A file as `load` reads it. */
  async #read(path: string): Promise<FileReading> {
    if (this.#readText === undefined) return readSystemFile(path);
    const text = await this.#readText(path);
    if (text === null) return { text, digest: DIGEST_ABSENT };
    return { text, digest: text === undefined ? unreadableDigest(undefined) : digestOf(text) };
  }

  /** The modules a hosts: line the check takes may need at this glibc, each as found now. */
  async #findModules(): Promise<ReadonlyMap<string, ModuleLook>> {
    const glibc = glibcVersionOf(this.#glibc);
    const builtIn = glibc !== undefined && atLeast(glibc, NSS_BUILT_IN_FROM);
    const names = ['files', 'dns', 'myhostname'].filter(
      (name) => !(builtIn && LIBC_MODULES.has(name)),
    );
    const looks = await Promise.all(names.map((name) => this.#moduleLook(name)));
    return new Map(names.map((name, k) => [name, looks[k] ?? { state: 'absent' }]));
  }

  /**
   * One reading compared with what load read: the hosts file's is followed, and any other file's
   * that moved is a move. The same for a look and for what the watch read during load.
   */
  #take(reading: WatchedReading, change: FileChange): void {
    const key = FILE_KEYS.find((each) => this.#files[each] === reading.file);
    if (key === undefined) return;
    this.#latest[key] = reading.digest;
    if (key === 'hosts') {
      if (reading.digest === this.#hosts.digest) return;
      this.#hosts = { text: reading.text, digest: reading.digest };
      change.applied.push(reading.file);
    } else if (reading.digest !== this.#atLoad[key].digest) {
      change.moved.push(reading.file);
      this.#move(
        `${reading.file} changed since ms-probe started, from ${digestSaid(this.#atLoad[key].digest)} to ${digestSaid(reading.digest)}: the check is off until ms-probe restarts`,
      );
    }
  }

  /**
   * `work`, raced against `ms`: one that has not ended by then is no longer waited on, so that the
   * resolver's watch, which awaits each look, is let go, and the check is off for now (`slow`). The
   * next look says whether it was slow or hung (`looked`).
   */
  async #bounded<T>(
    what: 'load' | 'look',
    ms: number,
    work: () => Promise<T>,
  ): Promise<T | undefined> {
    const running = work();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        const episode = { what, ms, settled: false };
        const settle = (): void => {
          episode.settled = true;
        };
        void running.then(settle, settle);
        this.#late = episode;
        this.#generation += 1;
        const why = `a ${what} of the system’s name settings did not end within ${String(ms)} ms: the check is off until it has`;
        // Off, and nothing else: what load read still stands, for the helper's snapshot too. A
        // move already named stays named, since the check is off until restart whatever this does.
        if (this.#moved === undefined) this.#view = { ...this.#view, off: { code: 'slow', why } };
        this.#logger.warn(
          { why },
          'the system’s name settings are slow to read: the name check is off for now',
        );
        resolve(undefined);
      }, ms);
      timer.unref();
    });
    try {
      return await Promise.race([running, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The first move since load, kept until restart, and logged. */
  #move(why: string): void {
    if (this.#moved !== undefined) return;
    this.#moved = { code: 'skew', why };
    this.#logger.warn(
      { why },
      'the system’s name settings moved: the name check is off until ms-probe restarts',
    );
  }

  /** Whether this process's glibc reads the file once, by what load read. */
  #readOnce(key: FileKey): boolean {
    const view = this.#view;
    if (!this.#loaded || view.glibc === undefined) return false;
    if (key === 'gaiConf') return !view.gaiReload;
    if (key === 'nsswitchConf') return !atLeast(view.glibc, NSSWITCH_RELOADS_FROM);
    // ld.so reads it once, as a process starts, before glibc's own code runs.
    return key === 'ldSoPreload';
  }

  #build(): PolicyView {
    // The policy's own failure is final: a load that ends after it changes nothing.
    if (this.#moved?.code === 'fault') return this.#offView(this.#moved);
    const hosts = this.#hosts.text;
    if (this.#hostsTable === undefined || this.#hostsTable.text !== hosts) {
      this.#hostsTable = { text: hosts, table: hostsTable(hosts ?? '') };
    }
    return viewOf(
      {
        platform: this.#platform,
        glibc: this.#glibc,
        env: this.#env,
        hostname: this.#loadHostname,
        hosts,
        resolvConf: this.#atLoad.resolvConf.text,
        nsswitchConf: this.#atLoad.nsswitchConf.text,
        gaiConf: this.#atLoad.gaiConf.text,
        ldSoPreload: this.#atLoad.ldSoPreload.text,
        codes: this.#codes(),
        nscd: this.#nscd,
        modules: this.#modules,
        ...(this.#moved === undefined ? {} : { moved: this.#moved }),
        hostsTable: this.#hostsTable.table,
      },
      this.#files,
    );
  }

  /** The error code of each file that could not be read, as the view names it. */
  #codes(): Partial<Record<FileKey, string>> {
    const codes: Partial<Record<FileKey, string>> = {};
    for (const key of FILE_KEYS) {
      const code = codeOfDigest(key === 'hosts' ? this.#hosts.digest : this.#atLoad[key].digest);
      if (code !== undefined) codes[key] = code;
    }
    return codes;
  }

  #offView(off: CheckOff): PolicyView {
    return {
      platform: this.#platform,
      glibc: undefined,
      conf: undefined,
      line: undefined,
      hosts: new Map(),
      nscd: false,
      modules: new Map(),
      gaiReload: false,
      off,
    };
  }

  /** The policy's own failure: off until restart, the first named and logged, once. */
  #fail(error: unknown): void {
    if (this.#moved?.code === 'fault') return;
    this.#logger.error(
      { err: error },
      'the system’s name policy could not be read: the check is off',
    );
    this.#moved = {
      code: 'fault',
      why: `the policy failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    this.#view = this.#offView(this.#moved);
  }
}
