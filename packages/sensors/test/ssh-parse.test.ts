import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ParseError,
  parseDf,
  parseLoadAverage,
  parseMeminfo,
  parseScriptOutput,
} from '../src/support/ssh/parse.js';

describe('df -P -k', () => {
  const OUTPUT = [
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1        104857600  41943040  62914560      40% /',
    '/dev/sdb1         10485760   1048576   9437184      10% /var/log',
  ].join('\n');

  it('reads the columns as bytes', () => {
    const [root] = parseDf(OUTPUT);
    assert.ok(root);
    assert.equal(root.filesystem, '/dev/sda1');
    assert.equal(root.mountedOn, '/');
    assert.equal(root.totalBytes, 100 * 1024 ** 3);
    assert.equal(root.usedBytes, 40 * 1024 ** 3);
    assert.equal(root.freeBytes, 60 * 1024 ** 3);
  });

  it('skips the header whatever it is called', () => {
    assert.equal(parseDf(OUTPUT).length, 2);
  });

  it('keeps a mount point that contains spaces', () => {
    // The mount point is the last field and is the only one that may contain a space, which is
    // why it is joined rather than indexed.
    const rows = parseDf(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
        '/dev/sdc1 1024 512 512 50% /mnt/my backup disk',
    );
    assert.equal(rows[0]?.mountedOn, '/mnt/my backup disk');
  });

  it('ignores a line that is not a filesystem rather than inventing numbers', () => {
    // What a device name wrapped onto its own line looks like without `-P`. It has too few
    // fields, and reading it as a row would attribute one filesystem's columns to another.
    const rows = parseDf(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
        '/dev/mapper/a-very-long-logical-volume-name\n' +
        '                 104857600  41943040  62914560      40% /',
    );
    assert.equal(rows.length, 0, 'a wrapped line must not be read as a row');
  });

  it('gives back nothing rather than something wrong for output it cannot read', () => {
    assert.deepEqual(parseDf('df: /nope: No such file or directory'), []);
    assert.deepEqual(parseDf(''), []);
  });
});

describe('load average', () => {
  it('reads /proc/loadavg', () => {
    assert.deepEqual(parseLoadAverage('0.08 0.09 0.25 1/234 5678\n'), {
      one: 0.08,
      five: 0.09,
      fifteen: 0.25,
    });
  });

  it('reads what uptime prints on Linux', () => {
    const line = ' 04:39:30 up 8 days, 23:33,  0 user,  load average: 0.08, 0.09, 0.25';
    assert.deepEqual(parseLoadAverage(line), { one: 0.08, five: 0.09, fifteen: 0.25 });
  });

  it('reads the plural BSD and macOS spelling', () => {
    const line = '11:04  up 3 days,  2:11, 2 users, load averages: 1.53 1.72 1.80';
    assert.deepEqual(parseLoadAverage(line), { one: 1.53, five: 1.72, fifteen: 1.8 });
  });

  it('reads a locale that writes the decimal point as a comma', () => {
    // The reason the numbers are pulled out by a pattern rather than by splitting on commas:
    // in these locales the separator *and* the decimal point are both commas.
    const line = ' 12:00:00 up 1 day,  load average: 0,52, 0,58, 0,59';
    assert.deepEqual(parseLoadAverage(line), { one: 0.52, five: 0.58, fifteen: 0.59 });
  });

  it('returns nothing rather than a guess for output it cannot read', () => {
    assert.equal(parseLoadAverage('bash: uptime: command not found'), null);
    assert.equal(parseLoadAverage(''), null);
  });
});

describe('/proc/meminfo', () => {
  const OUTPUT = [
    'MemTotal:        8126756 kB',
    'MemFree:         2886860 kB',
    'MemAvailable:    5292996 kB',
    'Buffers:           54220 kB',
    'Cached:          2776116 kB',
    'SwapTotal:       1048572 kB',
    'SwapFree:         498612 kB',
    'HugePages_Total:      12',
    'Hugepagesize:       2048 kB',
  ].join('\n');

  it('turns kB into bytes, because every line says kB and none of them mean it', () => {
    const values = parseMeminfo(OUTPUT);
    assert.equal(values.get('MemTotal'), 8_126_756 * 1024);
    assert.equal(values.get('MemAvailable'), 5_292_996 * 1024);
  });

  it('leaves a line with no unit as a count', () => {
    // `HugePages_Total` is a number of pages, not kilobytes. Multiplying it by 1024 would be a
    // made-up figure in a map somebody might later read.
    //
    // Twelve rather than the zero a real idle machine reports: with zero, multiplying by 1024
    // is still zero and the assertion holds however wrong the code is. A mutation run is what
    // found that — the test passed with the unit check removed entirely.
    assert.equal(parseMeminfo(OUTPUT).get('HugePages_Total'), 12);
    assert.equal(parseMeminfo(OUTPUT).get('Hugepagesize'), 2048 * 1024);
  });

  it('reads a key with brackets in it', () => {
    assert.equal(parseMeminfo('Active(anon):     123 kB').get('Active(anon)'), 123 * 1024);
  });

  it('ignores what it cannot read rather than failing the whole file', () => {
    const values = parseMeminfo('MemTotal: 100 kB\ngarbage line\nMemFree: 50 kB');
    assert.equal(values.size, 2);
  });
});

describe('the script output format', () => {
  it('takes a bare number as the single reading', () => {
    // The shortest thing a script can print, and the most common one.
    assert.deepEqual(parseScriptOutput('41.5\n'), {
      readings: [{ key: 'value', value: 41.5 }],
      message: '',
      ignored: 0,
    });
  });

  it('takes one reading per line', () => {
    const parsed = parseScriptOutput('temperature:41.5\nqueue:12\nmessage:all good\n');
    assert.deepEqual(parsed.readings, [
      { key: 'temperature', value: 41.5 },
      { key: 'queue', value: 12 },
    ]);
    assert.equal(parsed.message, 'all good');
  });

  it('takes = wherever it takes :', () => {
    // Half the world writes key=value, and being strict about which would be a rule with no
    // purpose behind it.
    assert.deepEqual(parseScriptOutput('queue=12').readings, [{ key: 'queue', value: 12 }]);
  });

  it('takes JSON when the output starts with a brace', () => {
    const parsed = parseScriptOutput('{"channels":{"queue":12},"message":"all good"}');
    assert.deepEqual(parsed.readings, [{ key: 'queue', value: 12 }]);
    assert.equal(parsed.message, 'all good');
  });

  it('counts a line it could not use rather than pretending it was not there', () => {
    const parsed = parseScriptOutput('queue:12\nsome stray log line\n');
    assert.equal(parsed.readings.length, 1);
    assert.equal(parsed.ignored, 1);
  });

  it('fails when a reading stopped being a number', () => {
    // The shape of a script that started printing an error where it used to print a figure.
    // Skipping the line would leave the channel silently gapped with no reason given.
    assert.throws(
      () => parseScriptOutput('queue:connection refused'),
      /reported "queue" as "connection refused", which is not a number/,
    );
  });

  it('fails on output with nothing in it, rather than reporting nothing', () => {
    assert.throws(() => parseScriptOutput('   \n  \n'), ParseError);
    assert.throws(() => parseScriptOutput('hello world'), /produced no readings/);
  });

  it('says so when the JSON is not JSON, rather than falling back to lines', () => {
    // Falling back would turn a quoting bug in a script into a confusing "no readings" instead
    // of naming the real problem.
    assert.throws(() => parseScriptOutput('{"channels":'), /starts with "{" but is not valid JSON/);
    assert.throws(() => parseScriptOutput('{"nope":1}'), /no "channels" object/);
  });

  it('does not treat a second bare number as a reading', () => {
    // The shorthand is for a script that prints one figure. Two bare lines is a script printing
    // something else, and guessing which was the reading would be a coin toss.
    const parsed = parseScriptOutput('41.5\n99\n');
    assert.deepEqual(parsed.readings, [{ key: 'value', value: 41.5 }]);
    assert.equal(parsed.ignored, 1);
  });
});
