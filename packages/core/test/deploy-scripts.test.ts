import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The operator's scripts, run for real against stub `systemctl`, `psql`, `pg_dump` and
 * `pg_restore` (`H-21`).
 *
 * The smoke tests prove these on a booted systemd with a real PostgreSQL, and they are heavy runs
 * — a release build and a container each. What they are poor at is the cases nobody sets up on
 * a real box: a password with a backtick in it, a core that is `activating` rather than `active`,
 * an archive taken with a TimescaleDB the host does not have, a copy that dies part-way. Each of
 * those is a line of shell that decides between a working installation and a broken one, so each
 * is run here, as the scripts, with only the programs on the other side of them replaced.
 *
 * Every stub writes what it was asked to `STUB_LOG`, and what the scripts did is read from there
 * and from the files they left.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const script = (name: string): string => join(repoRoot, 'deploy', name);

const linux = process.platform === 'linux';
/** `setup.sh` creates service users. Only somewhere that is thrown away afterwards. */
const throwawayRoot = linux && process.getuid?.() === 0 && existsSync('/.dockerenv');

interface Sandbox {
  readonly dir: string;
  readonly bin: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
  run(argv: readonly string[], extra?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  logged(): string;
}

/** A directory of stubs on the front of PATH, and a log they all write to. */
function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'ms-deploy-'));
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin);
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    HOME: dir,
    STUB_LOG: log,
    STUB_DIR: dir,
  };
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
  }
  return {
    dir,
    bin,
    log,
    env,
    run: (argv, extra = {}) =>
      spawnSync('bash', [...argv], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 60_000,
      }),
    logged: () => readFileSync(log, 'utf8'),
  };
}

const STUBS: Record<string, string> = {
  // `is-active` answers from STATE_ms_core / STATE_ms_probe, and exits as systemd does: 0 only
  // for `active`. `stop` notes which release was in place when it ran.
  systemctl: `
echo "systemctl $*" >> "$STUB_LOG"
svc="\${2%.service}"
case "$1" in
  is-active)
    var="STATE_\${svc//-/_}"
    state="\${!var:-inactive}"
    echo "$state"
    [ "$state" = active ]
    exit ;;
  stop)
    [ -z "\${STUB_PREFIX:-}" ] || echo "  in place when stopped: $(cat "$STUB_PREFIX/VERSION" 2>/dev/null)" >> "$STUB_LOG"
    exit 0 ;;
  restart)
    [ "\${FAIL_RESTART:-}" = "$svc" ] && exit 1
    exit 0 ;;
esac
exit 0
`,
  // Root for `-u`, and no `postgres` account, so nothing reaches for runuser.
  id: `
[ "$1" = -u ] && { echo 0; exit 0; }
exit 1
`,
  psql: `
sql=''
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    --*) ;;
    -*c) sql="\${args[$((i + 1))]}" ;;
  esac
done
[ -n "$sql" ] || sql="$(cat)"
{
  echo "psql: $sql"
  echo "  PGPASSWORD=\${PGPASSWORD-unset}"
  [ -z "\${PGPASSFILE:-}" ] || echo "  pgpass: $(cat "$PGPASSFILE")"
} >> "$STUB_LOG"
case "$sql" in
  'SELECT 1') echo 1 ;;
  *information_schema.tables*) echo 0 ;;
  *pg_available_extension_versions*) echo "\${STUB_AVAILABLE:-0}" ;;
  *'FROM pg_extension'*) cat "$STUB_DIR/extversion" 2>/dev/null || true ;;
  *'CREATE EXTENSION'*)
    v="$(printf '%s' "$sql" | sed -n "s/.*VERSION '\\([^']*\\)'.*/\\1/p")"
    echo "\${v:-9.9.9}" > "$STUB_DIR/extversion" ;;
  *server_version_num*) echo 17 ;;
  *'SHOW server_version'*) echo '17.6 (stub)' ;;
esac
exit 0
`,
  pg_dump: `
out=''
for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}" ;; esac; done
{
  echo "pg_dump"
  echo "  PGPASSWORD=\${PGPASSWORD-unset}"
  [ -z "\${PGPASSFILE:-}" ] || echo "  pgpass: $(cat "$PGPASSFILE")"
} >> "$STUB_LOG"
echo 'a dump' > "$out"
`,
  pg_restore: `
case " $* " in *" --list "*) echo '1; 1 1 TABLE public sample stub'; exit 0 ;; esac
echo "pg_restore $*" >> "$STUB_LOG"
exit 0
`,
};

/**
 * A password written the way a generator writes one, and the way that used to be run as root:
 * `ms-backup` and `ms-restore` `eval`ed `cfg_password="…"`, so `$x9` was an unbound variable under
 * `set -u`, and a backtick or `$(…)` was a command. `:` and `\` are what libpq's password file
 * escapes.
 */
function hostilePassword(dir: string): string {
  return `Tr0u$x9"b\`touch ${dir}/pwned-tick\`$(touch ${dir}/pwned-paren):c\\d`;
}

function pgpassLineFor(password: string): string {
  return `*:*:*:*:${password.replace(/[\\:]/g, (c) => `\\${c}`)}`;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** The parts of an enrolment bundle and a probe configuration these tests read. */
interface Bundle {
  readonly probeName: string;
  readonly accessKey: string;
}
interface ProbeFile {
  readonly core: Record<string, unknown>;
  readonly probe: { readonly checkQueueMaxLength?: number };
}
const readBundle = (path: string): Bundle => JSON.parse(readFileSync(path, 'utf8')) as Bundle;
const readProbeFile = (path: string): ProbeFile =>
  JSON.parse(readFileSync(path, 'utf8')) as ProbeFile;

describe('ms-backup', { skip: linux ? false : 'Linux only' }, () => {
  it('reads a password with shell in it as data, and records the TimescaleDB that took the dump', () => {
    const box = sandbox();
    const password = hostilePassword(box.dir);
    const data = join(box.dir, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'vault.key'), 'k');
    const config = join(box.dir, 'core.json');
    writeFileSync(
      config,
      JSON.stringify({
        database: {
          host: '127.0.0.1',
          port: 5432,
          database: 'monitoring',
          user: 'monitoring',
          password,
        },
        service: { dataDir: data },
      }),
    );
    writeFileSync(join(box.dir, 'extversion'), '2.17.1\n');
    const out = join(box.dir, 'out');

    const result = box.run([script('backup.sh'), '--config', config, '--out', out], {
      PGPASSWORD: 'from-the-environment',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    assert.ok(!existsSync(join(box.dir, 'pwned-tick')), 'a backtick in the password was run');
    assert.ok(!existsSync(join(box.dir, 'pwned-paren')), 'a $(…) in the password was run');
    const log = box.logged();
    assert.ok(log.includes(`pgpass: ${pgpassLineFor(password)}`), log);
    // The configuration's password wins over one the environment happened to carry.
    assert.ok(!log.includes('PGPASSWORD=from-the-environment'), log);

    const archive = spawnSync('bash', ['-c', `ls ${out}/*.tar.gz`], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.equal(mode(archive), 0o600);
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;
    assert.ok(!listing.includes('pgpass'), 'the password file went into the archive');
    const manifest = spawnSync('tar', ['-xzOf', archive, '--wildcards', '*/MANIFEST'], {
      encoding: 'utf8',
    }).stdout;
    assert.match(manifest, /^timescaledb=2\.17\.1$/m);
    assert.match(manifest, /^postgresql=17\.6 \(stub\)$/m);
  });

  it('leaves the environment to libpq when the configuration has no password', () => {
    // A password kept as a systemd credential is not in core.json, and the operator hands it
    // over as libpq always takes one.
    const box = sandbox();
    const config = join(box.dir, 'core.json');
    writeFileSync(config, JSON.stringify({ database: {}, service: { dataDir: box.dir } }));
    writeFileSync(join(box.dir, 'extversion'), '2.17.1\n');
    const result = box.run(
      [script('backup.sh'), '--config', config, '--out', join(box.dir, 'out')],
      {
        PGPASSWORD: 'from-the-environment',
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(box.logged().includes('PGPASSWORD=from-the-environment'), box.logged());
    assert.ok(!box.logged().includes('pgpass:'), box.logged());
  });
});

describe('ms-restore', { skip: linux ? false : 'Linux only' }, () => {
  /** An archive as `ms-backup` writes one, with the manifest line the case needs. */
  function archiveWith(box: Sandbox, manifest: string): string {
    const work = join(box.dir, 'archive', 'ms-backup-20260928T000000Z');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'MANIFEST'), `takenAt=20260928T000000Z\nversion=0.1.0\n${manifest}`);
    writeFileSync(join(work, 'database.dump'), 'a dump');
    const archive = join(box.dir, 'backup.tar.gz');
    spawnSync('tar', [
      '-czf',
      archive,
      '-C',
      join(box.dir, 'archive'),
      'ms-backup-20260928T000000Z',
    ]);
    return archive;
  }

  function confdir(box: Sandbox, database: Record<string, unknown>): string {
    const dir = join(box.dir, 'etc-ms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'core.json'), JSON.stringify({ database }));
    return dir;
  }

  function restore(
    box: Sandbox,
    archive: string,
    conf: string,
    extra: NodeJS.ProcessEnv = {},
  ): SpawnSyncReturns<string> {
    return box.run([script('restore.sh'), archive, '--database-only', '--confdir', conf], extra);
  }

  const restored = (box: Sandbox): boolean => /^pg_restore .*database\.dump/m.test(box.logged());

  for (const state of ['active', 'activating', 'deactivating', 'reloading']) {
    it(`refuses while ms-core is ${state}`, () => {
      // `activating` is the one that mattered: a core waiting for its database is `activating`
      // in five-minute rounds (`P-215`), and `is-active --quiet` let it through.
      const box = sandbox();
      const result = restore(box, archiveWith(box, ''), confdir(box, {}), { STATE_ms_core: state });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`ms-core is ${state}; stop it first`));
      assert.ok(!restored(box));
    });
  }

  it('refuses an archive taken with another TimescaleDB, before restoring anything', () => {
    const box = sandbox();
    writeFileSync(join(box.dir, 'extversion'), '2.28.3\n');
    const result = restore(box, archiveWith(box, 'timescaledb=2.27.2\n'), confdir(box, {}));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /taken with TimescaleDB 2\.27\.2, and this database has 2\.28\.3/);
    assert.match(result.stderr, /Nothing has been restored/);
    assert.match(result.stderr, /CREATE EXTENSION timescaledb VERSION '2\.27\.2'/);
    assert.match(result.stderr, /ALTER EXTENSION timescaledb UPDATE/);
    assert.ok(!restored(box));
  });

  it('refuses when this host cannot create the version the archive needs', () => {
    const box = sandbox();
    const result = restore(box, archiveWith(box, 'timescaledb=2.27.2\n'), confdir(box, {}), {
      STUB_AVAILABLE: '0',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not have that version installed/);
    assert.ok(
      !box.logged().includes('CREATE EXTENSION'),
      'it created an extension it then refused',
    );
    assert.ok(!restored(box));
  });

  it('creates the archived version, not the newest, when the database has none', () => {
    const box = sandbox();
    const result = restore(box, archiveWith(box, 'timescaledb=2.27.2\n'), confdir(box, {}), {
      STUB_AVAILABLE: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      box.logged().includes("psql: CREATE EXTENSION timescaledb VERSION '2.27.2'"),
      box.logged(),
    );
    assert.ok(restored(box));
  });

  it('restores into the same version, reading a password with shell in it as data', () => {
    const box = sandbox();
    const password = hostilePassword(box.dir);
    writeFileSync(join(box.dir, 'extversion'), '2.27.2\n');
    const result = restore(
      box,
      archiveWith(box, 'timescaledb=2.27.2\n'),
      confdir(box, { password }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(restored(box));
    assert.ok(!existsSync(join(box.dir, 'pwned-tick')), 'a backtick in the password was run');
    assert.ok(!existsSync(join(box.dir, 'pwned-paren')), 'a $(…) in the password was run');
    assert.ok(box.logged().includes(`pgpass: ${pgpassLineFor(password)}`), box.logged());
    assert.ok(!/PGPASSWORD=(?!unset)/.test(box.logged()), 'the password went into the environment');
    // What comes next names the configuration it restored, not the defaults.
    assert.match(result.stdout, /ms-core config check --config .*etc-ms\/core\.json/);
  });

  it('warns, and goes on, for an archive from before the version was recorded', () => {
    const box = sandbox();
    writeFileSync(join(box.dir, 'extversion'), '2.28.3\n');
    const result = restore(box, archiveWith(box, ''), confdir(box, {}));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /does not say which TimescaleDB took it/);
    assert.ok(restored(box));
  });

  it('refuses a manifest version or a database name that is not what it claims', () => {
    const quoted = sandbox();
    const bad = restore(
      quoted,
      archiveWith(quoted, "timescaledb=2.27.2';--\n"),
      confdir(quoted, {}),
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /which is not a version/);

    const named = sandbox();
    const odd = restore(named, archiveWith(named, ''), confdir(named, { database: "mon'itoring" }));
    assert.equal(odd.status, 1);
    assert.match(odd.stderr, /is not a name this script will pass to psql/);
    assert.ok(!restored(named));
  });
});

describe('ms-enrol', { skip: linux ? false : 'Linux only' }, () => {
  function enrolmentHost(): { box: Sandbox; conf: string } {
    const box = sandbox();
    const conf = join(box.dir, 'etc-ms');
    mkdirSync(join(conf, 'tls'), { recursive: true });
    const ca = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=test CA',
        '-keyout',
        join(conf, 'tls', 'ca.key'),
        '-out',
        join(conf, 'tls', 'ca.crt'),
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(ca.status, 0, ca.stderr);
    writeFileSync(join(conf, 'access-key'), 'the-enrolment-key\n');
    return { box, conf };
  }

  it('writes --out as a fresh 0600 file even over one that was readable', () => {
    const { box, conf } = enrolmentHost();
    const out = join(box.dir, 'web-dc2.enrol');
    writeFileSync(out, 'an old bundle');
    chmodSync(out, 0o644);
    const result = box.run([
      script('enrol-probe.sh'),
      'web-dc2',
      '--confdir',
      conf,
      '--host',
      'core.example',
      '--port',
      '23560',
      '--out',
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(mode(out), 0o600);
    assert.equal(readBundle(out).probeName, 'web-dc2');
  });

  it('makes a file on stdout private before writing the key into it', () => {
    // `sudo ms-enrol name > file`: the caller's shell made the file, with its own umask.
    const { box, conf } = enrolmentHost();
    const out = join(box.dir, 'redirected.enrol');
    const fd = openSync(out, 'w', 0o644);
    chmodSync(out, 0o644);
    try {
      const result = spawnSync(
        'bash',
        [
          script('enrol-probe.sh'),
          'web-dc2',
          '--confdir',
          conf,
          '--host',
          'core.example',
          '--port',
          '23560',
        ],
        {
          cwd: box.dir,
          env: box.env,
          stdio: ['ignore', fd, 'pipe'],
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      closeSync(fd);
    }
    assert.equal(mode(out), 0o600);
    assert.equal(readBundle(out).accessKey, 'the-enrolment-key');
  });
});

describe('placing a release', { skip: linux ? false : 'Linux only' }, () => {
  /** An unpacked release whose launcher's `config check` refuses any file that says "bad". */
  function release(box: Sandbox, version: string): string {
    const from = join(box.dir, `release-${version}`);
    for (const sub of ['app', 'bin', 'etc', 'deploy/systemd', 'docs']) {
      mkdirSync(join(from, sub), { recursive: true });
    }
    writeFileSync(join(from, 'VERSION'), `${version}\n`);
    writeFileSync(join(from, 'app', 'marker'), version);
    writeFileSync(join(from, 'docs', 'README.md'), version);
    for (const svc of ['core', 'probe']) {
      writeFileSync(
        join(from, 'bin', `ms-${svc}`),
        `#!/usr/bin/env bash\necho "ms-${svc} ${version} $*" >> "$STUB_LOG"\n` +
          `grep -q bad "$4" && { echo "api.port: must be integer"; exit 1; }\nexit 0\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(from, 'etc', `${svc}.json`), '{}');
      writeFileSync(join(from, 'deploy', 'systemd', `ms-${svc}.service`), '[Service]\n');
    }
    writeFileSync(join(from, 'deploy', 'setup.sh'), '#!/usr/bin/env bash\n');
    return from;
  }

  function installed(box: Sandbox): { prefix: string; conf: string } {
    const prefix = join(box.dir, 'opt-ms');
    const conf = join(box.dir, 'etc-ms');
    mkdirSync(join(prefix, 'app'), { recursive: true });
    mkdirSync(join(prefix, 'bin'));
    mkdirSync(conf);
    writeFileSync(join(prefix, 'VERSION'), '1.0.0\n');
    writeFileSync(join(prefix, 'app', 'marker'), '1.0.0');
    writeFileSync(join(prefix, 'operators-own-notes.txt'), 'mine');
    writeFileSync(join(conf, 'core.json'), '{"api":{"port":8080}}');
    writeFileSync(join(conf, 'probe.json'), '{}');
    return { prefix, conf };
  }

  const place = (box: Sandbox, from: string, prefix: string, conf: string, ...more: string[]) =>
    box.run(
      [script('place-release.sh'), '--from', from, '--prefix', prefix, '--confdir', conf, ...more],
      {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
        STUB_PREFIX: prefix,
      },
    );

  it('asks the new build first, and on a refusal changes nothing at all', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    writeFileSync(join(conf, 'core.json'), '{"api":{"port":"bad"}}');
    const result = place(box, release(box, '2.0.0'), prefix, conf);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not valid for 2\.0\.0/);
    assert.match(result.stderr, /Nothing was changed: 1\.0\.0 is still what is installed/);
    assert.match(result.stderr, /ms-core\s+active/);
    assert.ok(
      box.logged().includes('ms-core 2.0.0 config check --config'),
      'the new launcher was asked',
    );
    assert.ok(!box.logged().includes('systemctl stop'), 'something was stopped');
    assert.equal(readFileSync(join(prefix, 'VERSION'), 'utf8'), '1.0.0\n');
    assert.equal(readFileSync(join(prefix, 'app', 'marker'), 'utf8'), '1.0.0');
    assert.ok(!existsSync(join(prefix, '.incoming')), 'the copy was left behind');
    assert.ok(!existsSync(join(prefix, 'previous')));
  });

  it('stops the services before the swap, and keeps the release it replaced', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    const result = place(box, release(box, '2.0.0'), prefix, conf);
    assert.equal(result.status, 0, result.stderr);

    const log = box.logged();
    // Both stopped, and each while 1.0.0 was still the release in place — the swap came after.
    assert.match(log, /systemctl stop ms-probe\.service\n {2}in place when stopped: 1\.0\.0/);
    assert.match(log, /systemctl stop ms-core\.service\n {2}in place when stopped: 1\.0\.0/);
    assert.equal(readFileSync(join(prefix, 'VERSION'), 'utf8'), '2.0.0\n');
    assert.equal(readFileSync(join(prefix, 'app', 'marker'), 'utf8'), '2.0.0');
    assert.equal(
      readFileSync(join(prefix, 'docs', 'README.md'), 'utf8'),
      '2.0.0',
      'the release’s own docs',
    );
    assert.equal(readFileSync(join(prefix, 'previous', 'VERSION'), 'utf8'), '1.0.0\n');
    assert.equal(readFileSync(join(prefix, 'previous', 'app', 'marker'), 'utf8'), '1.0.0');
    assert.ok(existsSync(join(prefix, 'libexec', 'ms-setup')));
    assert.equal(readFileSync(join(prefix, 'operators-own-notes.txt'), 'utf8'), 'mine');
    assert.ok(!existsSync(join(prefix, '.incoming')));

    // A second upgrade: the rollback copy is always the release just replaced.
    assert.equal(place(box, release(box, '3.0.0'), prefix, conf).status, 0);
    assert.equal(readFileSync(join(prefix, 'previous', 'VERSION'), 'utf8'), '2.0.0\n');
  });

  it('touches nothing when the copy fails part-way', () => {
    // A full disk, standing in: the release has no `app` to copy.
    const box = sandbox();
    const { prefix, conf } = installed(box);
    const from = release(box, '2.0.0');
    spawnSync('rm', ['-rf', join(from, 'app')]);
    const result = place(box, from, prefix, conf);
    assert.notEqual(result.status, 0);
    assert.ok(!box.logged().includes('systemctl stop'));
    assert.equal(readFileSync(join(prefix, 'app', 'marker'), 'utf8'), '1.0.0');
    assert.ok(!existsSync(join(prefix, '.incoming')));
  });

  it('does not ask under --no-start, and still never swaps under a running service', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    writeFileSync(join(conf, 'core.json'), '{"api":{"port":"bad"}}');
    const result = place(box, release(box, '2.0.0'), prefix, conf, '--no-start');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!box.logged().includes('config check'));
    assert.match(
      box.logged(),
      /systemctl stop ms-core\.service\n {2}in place when stopped: 1\.0\.0/,
    );
    assert.equal(readFileSync(join(prefix, 'VERSION'), 'utf8'), '2.0.0\n');
  });
});

describe('the units an earlier release left in /etc', () => {
  it('are each one setup.sh knows as stock', () => {
    // `scripts/smoke/legacy-units` is what the smoke tests plant as "left by an earlier
    // release". If they stopped matching, setup would keep them as edited, and the smoke tests
    // would be proving the other branch while saying they proved this one.
    const setup = readFileSync(script('setup.sh'), 'utf8');
    for (const svc of ['ms-core', 'ms-probe']) {
      const hash = sha256(join(repoRoot, 'scripts', 'smoke', 'legacy-units', `${svc}.service`));
      assert.ok(setup.includes(hash), `${svc}: ${hash} is not in LEGACY_STOCK_UNITS`);
    }
  });

  it('never include the unit this release ships', () => {
    // It goes to /usr/lib, and one in /etc with the same bytes would be an operator's copy.
    const setup = readFileSync(script('setup.sh'), 'utf8');
    for (const svc of ['ms-core', 'ms-probe']) {
      const hash = sha256(join(repoRoot, 'deploy', 'systemd', `${svc}.service`));
      assert.ok(!setup.includes(hash), `${svc}: the shipped unit is listed as legacy`);
    }
  });
});

describe(
  'ms-setup',
  { skip: throwawayRoot ? false : 'needs root in a throwaway container' },
  () => {
    function installation(box: Sandbox, core: string | null): { prefix: string; conf: string } {
      const prefix = join(box.dir, 'opt-ms');
      const conf = join(box.dir, 'etc-ms');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(prefix, 'etc'));
      mkdirSync(join(prefix, 'deploy', 'systemd'), { recursive: true });
      mkdirSync(conf);
      writeFileSync(join(prefix, 'VERSION'), '2.0.0\n');
      for (const svc of ['core', 'probe']) {
        writeFileSync(
          join(prefix, 'bin', `ms-${svc}`),
          `#!/usr/bin/env bash\ngrep -q bad "$4" && { echo "api.port: must be integer"; exit 1; }\nexit 0\n`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(prefix, 'etc', `${svc}.json`),
          readFileSync(join(repoRoot, 'deploy', 'examples', `${svc}.json`)),
        );
        writeFileSync(
          join(prefix, 'deploy', 'systemd', `ms-${svc}.service`),
          readFileSync(join(repoRoot, 'deploy', 'systemd', `ms-${svc}.service`)),
        );
      }
      if (core !== null) writeFileSync(join(conf, 'core.json'), core);
      return { prefix, conf };
    }

    function setup(
      box: Sandbox,
      prefix: string,
      conf: string,
      args: readonly string[],
      extra: NodeJS.ProcessEnv = {},
    ): SpawnSyncReturns<string> {
      return box.run([script('setup.sh'), '--prefix', prefix, '--confdir', conf, ...args], {
        MS_SETUP_UNIT_DIR: join(box.dir, 'usr-lib-units'),
        MS_SETUP_LEGACY_UNIT_DIR: join(box.dir, 'etc-units'),
        ...extra,
      });
    }

    it('moves a stock unit out of /etc, keeps an edited one, and reloads before it enables', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const legacy = join(box.dir, 'etc-units');
      mkdirSync(legacy);
      const stock = readFileSync(
        join(repoRoot, 'scripts', 'smoke', 'legacy-units', 'ms-probe.service'),
      );
      writeFileSync(join(legacy, 'ms-probe.service'), stock);
      const edited = `${readFileSync(join(repoRoot, 'scripts', 'smoke', 'legacy-units', 'ms-core.service'), 'utf8')}\n[Service]\nLoadCredentialEncrypted=db-password:/etc/ms/db-password.cred\n`;
      writeFileSync(join(legacy, 'ms-core.service'), edited);

      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

      assert.ok(
        !existsSync(join(legacy, 'ms-probe.service')),
        'the stock unit was left to override',
      );
      assert.equal(
        readFileSync(join(legacy, 'ms-core.service'), 'utf8'),
        edited,
        'the edited unit was touched',
      );
      assert.match(result.stderr, /ms-core\.service was edited, so it was kept/);
      for (const svc of ['ms-core', 'ms-probe']) {
        assert.equal(
          sha256(join(box.dir, 'usr-lib-units', `${svc}.service`)),
          sha256(join(repoRoot, 'deploy', 'systemd', `${svc}.service`)),
        );
      }
      const log = box.logged();
      const at = (line: string): number => {
        const index = log.indexOf(line);
        assert.ok(index >= 0, `${line} was never run:\n${log}`);
        return index;
      };
      assert.ok(at('systemctl disable ms-probe.service') < at('systemctl daemon-reload'));
      assert.ok(at('systemctl daemon-reload') < at('systemctl enable ms-probe.service'));
      assert.ok(at('systemctl enable ms-core.service') < at('systemctl restart ms-core.service'));
      assert.ok(!log.includes('disable ms-core.service'), 'the kept unit was disabled');
    });

    it('on a refusal, has reloaded the units, starts nothing, and says what is running', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, '{"api":{"port":"bad"}}');
      const result = setup(box, prefix, conf, ['--components', 'core'], {
        STATE_ms_core: 'inactive',
      });

      assert.equal(result.status, 1);
      const log = box.logged();
      assert.ok(log.includes('systemctl daemon-reload'), 'the refusal came before the reload');
      assert.ok(log.includes('systemctl enable ms-core.service'));
      assert.ok(!log.includes('restart'), 'something was started on a refused configuration');
      assert.match(result.stderr, /does not load under 2\.0\.0, so nothing was started/);
      assert.match(result.stderr, /ms-core\s+inactive/);
      assert.doesNotMatch(result.stderr, /still up on the previous version/);
    });

    it('starts every service even when the first will not', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        FAIL_RESTART: 'ms-core',
        STATE_ms_probe: 'active',
      });
      assert.equal(result.status, 1);
      assert.ok(
        box.logged().includes('systemctl restart ms-probe.service'),
        'the probe was abandoned',
      );
      assert.ok(box.logged().includes('systemctl reset-failed ms-core.service'));
    });

    it('backs up a probe configuration before a new enrolment rewrites it', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      mkdirSync(join(conf, 'tls'));
      const original = `${JSON.stringify({ core: { host: 'old-core', port: 1, accessKey: 'old' }, probe: { checkQueueMaxLength: 4242 } }, null, 2)}\n`;
      writeFileSync(join(conf, 'probe.json'), original);
      const bundle = join(box.dir, 'web-dc2.enrol');
      writeFileSync(
        bundle,
        JSON.stringify({
          bundleVersion: 1,
          probeName: 'web-dc2',
          core: { host: 'new-core', port: 23560 },
          accessKey: 'new-key',
          tls: { ca: 'CA\n', cert: 'CERT\n', key: 'KEY\n' },
        }),
      );

      const result = setup(box, prefix, conf, [
        '--components',
        'probe',
        '--enrolment',
        bundle,
        '--no-start',
      ]);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

      const backups = spawnSync('bash', ['-c', `ls ${conf}/probe.json.*.bak`], { encoding: 'utf8' })
        .stdout.trim()
        .split('\n');
      assert.equal(backups.length, 1);
      assert.equal(
        readFileSync(backups[0] ?? '', 'utf8'),
        original,
        'the backup is not the operator’s file',
      );
      const now = readProbeFile(join(conf, 'probe.json'));
      assert.deepEqual(now.core, { host: 'new-core', port: 23560, accessKey: 'new-key' });
      assert.equal(now.probe.checkQueueMaxLength, 4242);
      assert.equal(readFileSync(join(conf, 'tls', 'probe.key'), 'utf8'), 'KEY\n');
      assert.equal(mode(join(conf, 'tls', 'probe.key')), 0o640);
      // A probe host has no use for the core's enrolment key, and must not grow one.
      assert.ok(!existsSync(join(conf, 'access-key')));
    });
  },
);
