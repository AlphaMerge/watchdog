import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  allowedTargetProblems,
  parseAllowedTarget,
  targetVerdict,
  type TargetVerdict,
} from '../src/net/allowed-targets.js';

/**
 * Where a credential set may go (`A-41b`). A table, because the rule is one: a host is judged
 * against the entries of its own sort, and a name facing only addresses is not the core's to
 * decide.
 */

describe('whether a host is inside a set’s targets (A-41b)', () => {
  const cases: readonly (readonly [string, readonly string[], TargetVerdict])[] = [
    // Names, whole.
    ['db1.example.com', ['db1.example.com'], 'inside'],
    ['DB1.Example.COM.', ['db1.example.com'], 'inside'],
    ['db1.example.com', ['DB1.EXAMPLE.COM.'], 'inside'],
    ['db2.example.com', ['db1.example.com'], 'outside'],
    ['db1.example.com.evil.test', ['db1.example.com'], 'outside'],
    // Patterns: strictly below the domain.
    ['db1.example.com', ['*.example.com'], 'inside'],
    ['a.b.example.com', ['*.example.com'], 'inside'],
    ['example.com', ['*.example.com'], 'outside'],
    ['badexample.com', ['*.example.com'], 'outside'],
    ['example.com.evil.test', ['*.example.com'], 'outside'],
    // Addresses and ranges.
    ['10.20.1.5', ['10.20.0.0/16'], 'inside'],
    ['10.21.1.5', ['10.20.0.0/16'], 'outside'],
    ['10.20.1.5', ['10.20.1.5'], 'inside'],
    ['10.20.1.6', ['10.20.1.5'], 'outside'],
    ['::ffff:10.20.1.5', ['10.20.0.0/16'], 'inside'],
    ['fd00:1::7', ['fd00:1::/64'], 'inside'],
    ['fd00:2::7', ['fd00:1::/64'], 'outside'],
    ['FD00:1::7', ['fd00:1::7'], 'inside'],
    ['fe80::1%eth0', ['fe80::/10'], 'inside'],
    ['10.0.0.1', ['0.0.0.0/0'], 'inside'],
    // IPv4 written as IPv6, in the entry this time.
    ['10.20.1.5', ['::ffff:10.20.1.5'], 'inside'],
    ['10.1.2.3', ['::ffff:10.0.0.0/104'], 'inside'],
    ['11.0.0.1', ['::ffff:10.0.0.0/104'], 'outside'],
    // An address never matches a name, however the name resolves.
    ['10.20.1.5', ['db1.example.com', '*.example.com'], 'outside'],
    // A name facing addresses is the one case the core cannot decide.
    ['db1.example.com', ['10.20.0.0/16'], 'undecided'],
    ['db1.example.com', ['10.20.1.5'], 'undecided'],
    // ...unless a name entry already lets it in.
    ['db1.example.com', ['10.20.0.0/16', '*.example.com'], 'inside'],
    ['db1.other.test', ['10.20.0.0/16', '*.example.com'], 'undecided'],
    // An entry that means nothing allows nothing.
    ['10.20.1.5', ['10.20.0.0/99'], 'outside'],
    ['db1.example.com', ['*'], 'outside'],
    // A PostgreSQL socket directory is the probe's own machine (`A-74`): decided, never left to
    // a probe to resolve, as loopback is.
    ['/var/run/postgresql', ['10.20.0.0/16'], 'outside'],
    ['/var/run/postgresql', ['10.20.1.5', '*.example.com'], 'outside'],
    ['/var/run/postgresql', ['127.0.0.1'], 'inside'],
    ['/var/run/postgresql', ['127.0.0.0/8'], 'inside'],
    ['/var/run/postgresql', ['::1'], 'inside'],
    ['/var/run/postgresql', ['localhost'], 'inside'],
    ['/tmp', ['0.0.0.0/0'], 'inside'],
    ['/var/run/postgresql', ['127.0.0.2'], 'outside'],
    // ...on POSIX. Windows reads these as a pipe on another machine, so they are names here:
    // undecided against addresses, and left to a pin that cannot resolve them.
    ['//10.0.0.66/pipe', ['127.0.0.1'], 'undecided'],
    ['/\\host\\pipe', ['127.0.0.1'], 'undecided'],
    ['/var/run\\postgresql', ['127.0.0.1'], 'undecided'],
    ['//10.0.0.66/pipe', ['localhost'], 'outside'],
  ];
  for (const [host, entries, expected] of cases) {
    it(`${host} against ${entries.join(', ')} is ${expected}`, () => {
      assert.equal(targetVerdict(host, entries), expected);
    });
  }
});

describe('what an entry may be (A-41b)', () => {
  it('reads each of the four sorts', () => {
    assert.deepEqual(parseAllowedTarget(' DB1.Example.com. '), {
      kind: 'name',
      name: 'db1.example.com',
    });
    assert.deepEqual(parseAllowedTarget('*.Example.com'), {
      kind: 'suffix',
      suffix: 'example.com',
    });
    assert.deepEqual(parseAllowedTarget('10.0.0.1'), {
      kind: 'address',
      address: '10.0.0.1',
      family: 'ipv4',
    });
    assert.deepEqual(parseAllowedTarget('fd00::/8'), {
      kind: 'range',
      network: 'fd00::',
      prefix: 8,
      family: 'ipv6',
    });
  });

  it('reads an IPv4 address written as IPv6 as the address it is, and a mapped range as it is written', () => {
    // One entry for two spellings, so rewriting one as the other widens nothing.
    assert.deepEqual(parseAllowedTarget('::FFFF:10.0.0.1'), {
      kind: 'address',
      address: '10.0.0.1',
      family: 'ipv4',
    });
    // A prefix of 104 is IPv6's to have: unmapping the network would make it no range at all.
    assert.deepEqual(parseAllowedTarget('::ffff:10.0.0.0/104'), {
      kind: 'range',
      network: '::ffff:10.0.0.0',
      prefix: 104,
      family: 'ipv6',
    });
  });

  it('refuses what is none of them, saying what an entry may be', () => {
    const refused = ['', '*', 'a.*.example.com', '*.com', '10.0.0.0/33', 'fd00::/129', 'x/8'];
    const problems = allowedTargetProblems(['ok.example.com', ...refused, '10.0.0.0/8']);
    assert.deepEqual(
      problems.map((problem) => problem.index),
      refused.map((_, at) => at + 1),
    );
    for (const problem of problems) assert.ok(problem.message.length > 20, problem.message);
    assert.match(problems[1]?.message ?? '', /no targets at all/);
    assert.match(problems[4]?.message ?? '', /CIDR/);
  });

  it('refuses a name no DNS could hold', () => {
    for (const bad of ['-lead.example.com', 'trail-.example.com', 'a..b', `${'a'.repeat(64)}.x`]) {
      assert.equal(typeof parseAllowedTarget(bad), 'string', bad);
    }
  });
});
