import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { coreConfigSchema, PRODUCT_ENV, probeConfigSchema } from '@ms/shared';

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
  # \`show UNIT -p Prop --value\` answers from SHOW_ms_probe_Result and the like.
  show)
    var="SHOW_\${svc//-/_}_$4"
    echo "\${!var:-}"
    exit 0 ;;
  is-enabled)
    var="ENABLED_\${svc//-/_}"
    state="\${!var:-enabled}"
    echo "$state"
    [ "$state" = enabled ]
    exit ;;
  # Failed when is-active would say so; the unit is the last argument, after any --quiet.
  is-failed)
    unit="\${*: -1}"
    var="STATE_\${unit%.service}"
    var="\${var//-/_}"
    [ "\${!var:-inactive}" = failed ]
    exit ;;
esac
exit 0
`,
  'systemd-run': `
echo "systemd-run $*" >> "$STUB_LOG"
exit 0
`,
  // \`get-property org.freedesktop.systemd1 PATH IFACE PROP\` answers from BUS_ms_probe_RestartUSec
  // and the like: the shipped five seconds unless told otherwise, and unreadable when set empty.
  busctl: `
unit="\${3##*/}"
unit="\${unit//_2d/_}"
unit="\${unit%_2eservice}"
var="BUS_\${unit}_$5"
value="\${!var-5000000}"
[ -n "$value" ] || exit 1
echo "t $value"
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

/**
 * A launcher whose `config check` refuses any file that says `refused-port`. Letters a hex key
 * cannot spell: setup writes one into every configuration it installs, and a marker of `bad`
 * refused about 1.5% of runs for the key alone.
 *
 * A file that says `no-effect-setting` is warned about the way `runConfigCheck` warns (`B-08`):
 * two lines marked `warning: ` on stderr, before anything else and whether or not the check then
 * passes. A pass says what a real one says, on stdout, and one of its lines has the marker in
 * the middle of it — which is not a warning. Every call is written to `STUB_LOG`.
 */
function launcher(svc: string, version: string): string {
  return (
    `#!/usr/bin/env bash\necho "ms-${svc} ${version} $*" >> "$STUB_LOG"\n` +
    `if grep -q no-effect-setting "$4"; then\n` +
    `  echo "warning: flowListener.enabled: is true, and this build carries no flow sensor type" >&2\n` +
    `  echo "warning: a second thing ms-${svc} starts with" >&2\nfi\n` +
    `grep -q refused-port "$4" && { echo "api.port: must be integer"; exit 1; }\n` +
    `echo "configuration is valid for ms-${svc} ${version}"\n` +
    `echo "  file            $4"\n` +
    `echo "  ignored MS_*    MS_NOT_A_warning: line"\nexit 0\n`
  );
}

/** What the stub launcher warns of first, as the check writes it. */
const FIRST_WARNING =
  'warning: flowListener.enabled: is true, and this build carries no flow sensor type';

/** How many times `needle` is in `text`. */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** An unpacked release, with the launcher above for each service. */
function release(box: Sandbox, version: string): string {
  const from = join(box.dir, `release-${version}`);
  for (const sub of ['app', 'bin', 'etc', 'deploy/systemd', 'docs']) {
    mkdirSync(join(from, sub), { recursive: true });
  }
  writeFileSync(join(from, 'VERSION'), `${version}\n`);
  writeFileSync(join(from, 'app', 'marker'), version);
  writeFileSync(join(from, 'docs', 'README.md'), version);
  for (const svc of ['core', 'probe']) {
    writeFileSync(join(from, 'bin', `ms-${svc}`), launcher(svc, version), { mode: 0o755 });
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

describe('placing a release', { skip: linux ? false : 'Linux only' }, () => {
  it('asks the new build first, and on a refusal changes nothing at all', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    writeFileSync(join(conf, 'core.json'), '{"api":{"port":"refused-port"}}');
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

  it('keeps a passing check’s warnings to itself, which are ms-setup’s to show (`H-27`)', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    writeFileSync(join(conf, 'probe.json'), '{"flowListener":{"enabled":"no-effect-setting"}}');
    const result = place(box, release(box, '2.0.0'), prefix, conf);

    assert.equal(result.status, 0, result.stderr);
    // The check was asked, and warned; nothing of it is said here, on either stream. Said here
    // and by ms-setup, which every tarball install runs next, it was said twice.
    assert.ok(box.logged().includes('ms-probe 2.0.0 config check --config'), box.logged());
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /warning|is valid for/);

    // The upgrade itself is the one a silent pass gets.
    const log = box.logged();
    assert.match(log, /systemctl stop ms-probe\.service\n {2}in place when stopped: 1\.0\.0/);
    assert.equal(readFileSync(join(prefix, 'VERSION'), 'utf8'), '2.0.0\n');
    assert.equal(readFileSync(join(prefix, 'previous', 'VERSION'), 'utf8'), '1.0.0\n');
    assert.ok(!existsSync(join(prefix, '.incoming')));
  });

  it('says nothing about a check that passed with nothing to say', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    const result = place(box, release(box, '2.0.0'), prefix, conf);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /is valid for|warning/);
  });

  it('refuses a check that failed exactly as before, warnings and all', () => {
    const box = sandbox();
    const { prefix, conf } = installed(box);
    writeFileSync(
      join(conf, 'core.json'),
      '{"api":{"port":"refused-port"},"x":"no-effect-setting"}',
    );
    const result = place(box, release(box, '2.0.0'), prefix, conf);

    assert.equal(result.status, 1);
    // The whole of what the check said, in the order it said it, under the refusal's heading.
    const said = result.stderr.split('\n');
    const heading = said.findIndex((line) => line.includes('core.json is not valid for 2.0.0'));
    assert.ok(heading >= 0, result.stderr);
    assert.deepEqual(said.slice(heading + 1, heading + 4), [
      '    warning: flowListener.enabled: is true, and this build carries no flow sensor type',
      '    warning: a second thing ms-core starts with',
      '    api.port: must be integer',
    ]);
    assert.doesNotMatch(result.stderr, /is valid for|goes ahead/);
    assert.match(result.stderr, /Nothing was changed: 1\.0\.0 is still what is installed/);
    assert.ok(!box.logged().includes('systemctl stop'), 'something was stopped');
    assert.equal(readFileSync(join(prefix, 'VERSION'), 'utf8'), '1.0.0\n');
    assert.ok(!existsSync(join(prefix, '.incoming')), 'the copy was left behind');
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
    writeFileSync(join(conf, 'core.json'), '{"api":{"port":"refused-port"}}');
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

describe(
  'ms-recover: a service the start limit stopped comes back (`H-23`)',
  {
    skip: linux ? false : 'Linux only',
  },
  () => {
    /**
     * What systemd recorded, read with `systemctl show`, after each way a unit with the shipped
     * restart settings can fail (`H-23`): `ms-probe` itself on Debian 12, and a unit with its
     * restart settings on Rocky 9 and Ubuntu 24.04. **On all three, a crash loop that runs into the
     * limit keeps the crash's own result**, never `start-limit-hit`. What marks it is the wait:
     * RestartSec (5 s) between the process exiting and the unit failing, where a refused
     * configuration or a stop fails the unit within two milliseconds.
     */
    const measured = {
      /** systemd 252.39-1~deb12u2. */
      debian12: {
        /** ms-probe killed six times, the sixth restart refused by the limit. */
        crashLoop: {
          Result: 'signal',
          ExecMainCode: '2',
          ExecMainStatus: '9',
          NRestarts: '5',
          ExecMainExitTimestampMonotonic: '63741842021',
          StateChangeTimestampMonotonic: '63746861027',
        },
        /** Started by hand six times in ten minutes, stopping cleanly each time. */
        manualStartRefused: {
          Result: 'start-limit-hit',
          ExecMainCode: '1',
          ExecMainStatus: '0',
          NRestarts: '0',
          ExecMainExitTimestampMonotonic: '63807000194',
          StateChangeTimestampMonotonic: '63807075689',
        },
        /** A configuration it refused: exit 78, never restarted. */
        configRefused: {
          Result: 'exit-code',
          ExecMainCode: '1',
          ExecMainStatus: '78',
          NRestarts: '0',
          ExecMainExitTimestampMonotonic: '63766603985',
          StateChangeTimestampMonotonic: '63766604144',
        },
        /** `systemctl stop` of a probe that ignored its stop signal, killed at TimeoutStopSec. */
        stopTimedOut: {
          Result: 'timeout',
          ExecMainCode: '2',
          ExecMainStatus: '9',
          NRestarts: '0',
          ExecMainExitTimestampMonotonic: '63781143054',
          StateChangeTimestampMonotonic: '63781143224',
        },
      },
      /** systemd 252-67.el9_8.6.rocky.0.1. */
      rocky9: {
        crashLoop: {
          Result: 'signal',
          ExecMainCode: '2',
          ExecMainStatus: '9',
          NRestarts: '5',
          ExecMainExitTimestamp: 'Tue 2026-09-29 01:14:03 UTC',
          ExecMainExitTimestampMonotonic: '64290960361',
          StateChangeTimestamp: 'Tue 2026-09-29 01:14:08 UTC',
          StateChangeTimestampMonotonic: '64296114805',
        },
        configRefused: {
          Result: 'exit-code',
          ExecMainCode: '1',
          ExecMainStatus: '78',
          NRestarts: '0',
          ExecMainExitTimestamp: 'Tue 2026-09-29 01:14:10 UTC',
          ExecMainExitTimestampMonotonic: '64298008085',
          StateChangeTimestamp: 'Tue 2026-09-29 01:14:10 UTC',
          StateChangeTimestampMonotonic: '64298008369',
        },
        stopTimedOut: {
          Result: 'timeout',
          ExecMainCode: '2',
          ExecMainStatus: '9',
          NRestarts: '0',
          ExecMainExitTimestamp: 'Tue 2026-09-29 01:14:15 UTC',
          ExecMainExitTimestampMonotonic: '64303598388',
          StateChangeTimestamp: 'Tue 2026-09-29 01:14:15 UTC',
          StateChangeTimestampMonotonic: '64303598578',
        },
      },
      /** systemd 255.4-1ubuntu8.17. */
      ubuntu2404: {
        crashLoop: {
          Result: 'signal',
          ExecMainCode: '2',
          ExecMainStatus: '9',
          NRestarts: '5',
          ExecMainExitTimestamp: 'Tue 2026-09-29 01:14:46 UTC',
          ExecMainExitTimestampMonotonic: '64334031542',
          StateChangeTimestamp: 'Tue 2026-09-29 01:14:51 UTC',
          StateChangeTimestampMonotonic: '64339098017',
        },
        configRefused: {
          Result: 'exit-code',
          ExecMainCode: '1',
          ExecMainStatus: '78',
          NRestarts: '0',
          ExecMainExitTimestamp: 'Tue 2026-09-29 01:14:52 UTC',
          ExecMainExitTimestampMonotonic: '64340541791',
          StateChangeTimestamp: 'Tue 2026-09-29 01:14:52 UTC',
          StateChangeTimestampMonotonic: '64340541910',
        },
        stopTimedOut: {
          Result: 'timeout',
          ExecMainCode: '2',
          ExecMainStatus: '9',
          NRestarts: '0',
          ExecMainExitTimestamp: 'Tue 2026-09-29 01:14:58 UTC',
          ExecMainExitTimestampMonotonic: '64346095283',
          StateChangeTimestamp: 'Tue 2026-09-29 01:14:58 UTC',
          StateChangeTimestampMonotonic: '64346096756',
        },
      },
    } satisfies Record<string, Record<string, Record<string, string>>>;
    const distros = Object.entries(measured);

    /** The stub's `systemctl show` answers for ms-probe. */
    function shows(properties: Record<string, string>): NodeJS.ProcessEnv {
      return Object.fromEntries(
        Object.entries(properties).map(([name, value]) => [`SHOW_ms_probe_${name}`, value]),
      );
    }

    /** A crash loop's record under a RestartSec of `restartUsec`, failed `gapUsec` after exit. */
    function loopAfter(restartUsec: number, gapUsec: number): NodeJS.ProcessEnv {
      const exited = 70_000_000_000;
      return {
        ...shows({
          ...measured.debian12.crashLoop,
          ExecMainExitTimestampMonotonic: String(exited),
          StateChangeTimestampMonotonic: String(exited + gapUsec),
        }),
        BUS_ms_probe_RestartUSec: String(restartUsec),
      };
    }

    /** A host where ms-probe has just failed, and what systemd says about it. */
    function failedProbe(env: NodeJS.ProcessEnv = {}): {
      box: Sandbox;
      recover: (argv: readonly string[], extra?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
      state: string;
    } {
      const box = sandbox();
      const stateDir = join(box.dir, 'run-ms-recover');
      const base: NodeJS.ProcessEnv = {
        STATE_ms_probe: 'failed',
        ...shows(measured.debian12.crashLoop),
        MS_RECOVER_STATE_DIR: stateDir,
        MS_RECOVER_NOW: '100000',
        MS_RECOVER_SELF: '/opt/ms/bin/ms-recover',
        ...env,
      };
      return {
        box,
        recover: (argv, extra = {}) =>
          box.run([script('recover.sh'), ...argv], { ...base, ...extra }),
        state: join(stateDir, 'ms-probe'),
      };
    }

    /** The cool-down the last `systemd-run` in the log was given, in seconds. */
    function scheduled(log: string): number | undefined {
      const runs = [...log.matchAll(/^systemd-run .*--on-active=(\d+) /gm)];
      const last = runs.at(-1);
      return last === undefined ? undefined : Number(last[1]);
    }

    /** Asserts ms-recover left ms-probe alone, saying `why`. */
    function leftAlone(env: NodeJS.ProcessEnv, why: RegExp): void {
      const { box, recover, state } = failedProbe(env);
      const result = recover(['ms-probe']);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(box.logged(), /systemd-run/, JSON.stringify(env));
      assert.match(result.stdout, why, JSON.stringify(env));
      assert.equal(existsSync(state), false);
    }

    it('schedules one retry of a crash loop the start limit stopped, after ten minutes', () => {
      const { box, recover, state } = failedProbe();
      const result = recover(['ms-probe']);
      assert.equal(result.status, 0, result.stderr);

      const log = box.logged();
      assert.equal(scheduled(log), 600);
      assert.match(log, /--unit=ms-recover-ms-probe-retry /);
      assert.match(log, /--collect /);
      assert.match(log, / \/opt\/ms\/bin\/ms-recover --now ms-probe$/m);
      // A retry left from an earlier failure is replaced, never doubled up.
      const stop = log.indexOf('systemctl stop ms-recover-ms-probe-retry.timer');
      assert.ok(stop >= 0 && stop < log.indexOf('systemd-run'), log);
      assert.match(result.stdout, /starting it again in 10 min, at \d\d:\d\d \(attempt 1\)/);
      assert.match(result.stdout, /systemctl disable ms-probe\.service/);
      assert.equal(readFileSync(state, 'utf8').trim(), '1');
    });

    it('tells a crash loop from a refusal and a stop on each distro measured', () => {
      for (const [distro, records] of distros) {
        const { box, recover } = failedProbe(shows(records.crashLoop));
        assert.equal(recover(['ms-probe']).status, 0);
        assert.equal(scheduled(box.logged()), 600, `${distro}: the crash loop`);
        leftAlone(shows(records.configRefused), /refused its configuration \(exit 78\)/);
        leftAlone(shows(records.stopTimedOut), /not a crash loop, so it is left alone/);
      }
    });

    it('schedules a retry of a start the limit refused, too', () => {
      const { box, recover } = failedProbe(shows(measured.debian12.manualStartRefused));
      assert.equal(recover(['ms-probe']).status, 0);
      assert.equal(scheduled(box.logged()), 600);
    });

    it('leaves a unit that refused its configuration alone, even after a refused start', () => {
      // RestartPreventExitStatus=78, so it is never restarted and a person has to fix the file
      // (`P-222`). Asked first, so what came after the refusal changes nothing.
      leftAlone(
        shows({ ...measured.debian12.crashLoop, ExecMainCode: '1', ExecMainStatus: '78' }),
        /refused its configuration \(exit 78\): not a crash loop/,
      );
    });

    it('leaves a stop, or a unit systemd was not restarting, alone', () => {
      for (const record of [
        // The operator's stop is theirs, even after earlier crashes.
        { ...measured.debian12.stopTimedOut, NRestarts: '3' },
        // Failed long after it exited, but systemd was not restarting it.
        { ...measured.debian12.crashLoop, NRestarts: '0' },
      ]) {
        leftAlone(shows(record), /not a crash loop, so it is left alone/);
      }
    });

    it('reads the wait from the unit’s own RestartSec, never assuming five seconds', () => {
      // An operator's drop-in with a longer RestartSec: its loops still wait that long.
      const { box, recover } = failedProbe(loopAfter(30_000_000, 30_051_000));
      assert.equal(recover(['ms-probe']).status, 0);
      assert.equal(scheduled(box.logged()), 600);
      // Under it, two seconds between exit and failure is not a refused restart. A stop that took
      // that long to kill what the process left behind, after crashes the day before.
      leftAlone(loopAfter(30_000_000, 2_000_000), /not a crash loop, so it is left alone/);
    });

    it('says why it cannot tell under a RestartSec below a second, and leaves it', () => {
      leftAlone(
        loopAfter(500_000, 500_000),
        /RestartSec is below 1 s: a refused restart cannot be told/,
      );
      leftAlone(loopAfter(0, 0), /RestartSec is below 1 s/);
    });

    it('goes by the monotonic clock, whatever NTP did to the wall clock between', () => {
      // Stepped back an hour between the exit and the failure: the wall clock says the unit
      // failed before its process exited. Still the loop.
      const stepped = {
        ...measured.ubuntu2404.crashLoop,
        StateChangeTimestamp: 'Tue 2026-09-29 00:14:51 UTC',
      };
      const { box, recover } = failedProbe(shows(stepped));
      assert.equal(recover(['ms-probe']).status, 0);
      assert.equal(scheduled(box.logged()), 600);
      // Stepped forward an hour: the wall clock says the stop waited an hour. Still the stop.
      leftAlone(
        shows({
          ...measured.ubuntu2404.stopTimedOut,
          StateChangeTimestamp: 'Tue 2026-09-29 02:14:58 UTC',
        }),
        /not a crash loop, so it is left alone/,
      );
    });

    it('leaves a unit whose record it cannot read alone', () => {
      for (const env of [
        shows({ ...measured.debian12.crashLoop, ExecMainExitTimestampMonotonic: '' }),
        shows({ ...measured.debian12.crashLoop, NRestarts: 'n/a' }),
        { BUS_ms_probe_RestartUSec: '' },
      ]) {
        leftAlone(env, /record of it cannot be read, so it is left alone/);
      }
    });

    it('leaves a unit the operator disabled down', () => {
      const { box, recover } = failedProbe({ ENABLED_ms_probe: 'disabled' });
      const result = recover(['ms-probe']);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(box.logged(), /systemd-run/);
      assert.match(result.stdout, /it is disabled, so it is left down/);
    });

    it('doubles the cool-down on each retry that crashes again, to four hours', () => {
      const { box, recover } = failedProbe();
      const delays: (number | undefined)[] = [];
      for (let failure = 0; failure < 7; failure += 1) {
        // A minute after each retry it has crashed five times again: well inside the hour.
        const now = String(100_000 + failure * 60);
        assert.equal(recover(['ms-probe'], { MS_RECOVER_NOW: now }).status, 0);
        delays.push(scheduled(box.logged()));
        assert.equal(recover(['--now', 'ms-probe'], { MS_RECOVER_NOW: now }).status, 0);
      }
      assert.deepEqual(delays, [600, 1_200, 2_400, 4_800, 9_600, 14_400, 14_400]);
    });

    it('starts from ten minutes again once the service stayed up for an hour', () => {
      const { box, recover, state } = failedProbe();
      mkdirSync(join(box.dir, 'run-ms-recover'), { recursive: true });
      // Four retries in, the last of them at 100,000 s after boot.
      writeFileSync(state, '4 100000\n');
      assert.equal(recover(['ms-probe'], { MS_RECOVER_NOW: '103599' }).status, 0);
      assert.equal(
        scheduled(box.logged()),
        9_600,
        'a minute short of the hour: still the same loop',
      );
      assert.equal(recover(['ms-probe'], { MS_RECOVER_NOW: '103600' }).status, 0);
      assert.equal(scheduled(box.logged()), 600, 'an hour up: a new problem, not the old one');
    });

    it('when due, clears the start limit and starts the unit, without waiting on it', () => {
      const { box, recover } = failedProbe();
      const result = recover(['--now', 'ms-probe']);
      assert.equal(result.status, 0, result.stderr);
      const log = box.logged();
      const reset = log.indexOf('systemctl reset-failed ms-probe.service');
      const start = log.indexOf('systemctl start --no-block ms-probe.service');
      // Both, and in that order: a start without the reset is refused by the limit that stopped it.
      assert.ok(reset >= 0 && start >= 0, log);
      assert.ok(reset < start, log);
    });

    it('when due, does nothing to a unit somebody has since started, reconfigured or stopped', () => {
      for (const env of [
        { STATE_ms_probe: 'active' },
        shows(measured.debian12.configRefused),
        shows(measured.debian12.stopTimedOut),
        { ENABLED_ms_probe: 'disabled' },
      ]) {
        const { box, recover } = failedProbe(env);
        const result = recover(['--now', 'ms-probe']);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(box.logged(), /reset-failed|start --no-block/, JSON.stringify(env));
      }
    });

    it('acts on ms-core and ms-probe and nothing else, because it runs as root', () => {
      const { box, recover } = failedProbe();
      for (const name of ['sshd', 'ms-core; reboot', '../ms-probe', '']) {
        const result = recover([name]);
        assert.equal(result.status, 2, name);
      }
      assert.doesNotMatch(box.logged(), /systemd-run|reset-failed/);
    });
  },
);

describe('what starts a crashed service again, and who ships it (`H-23`)', () => {
  const unit = (name: string): string =>
    readFileSync(join(repoRoot, 'deploy', 'systemd', name), 'utf8');

  it('is named by both services, for their failures', () => {
    for (const svc of ['ms-core', 'ms-probe']) {
      assert.match(unit(`${svc}.service`), /^OnFailure=ms-recover@%N\.service$/m, svc);
      // What keeps exit 78 out of it: never restarted, so it cannot reach the start limit.
      assert.match(unit(`${svc}.service`), /^RestartPreventExitStatus=78$/m, svc);
    }
  });

  it('runs the script the release puts in bin', () => {
    assert.match(unit('ms-recover@.service'), /^ExecStart=\/opt\/ms\/bin\/ms-recover %i$/m);
    const pkg = readFileSync(join(repoRoot, 'scripts', 'package.sh'), 'utf8');
    assert.match(pkg, /deploy\/recover\.sh" "\$\{stage\}\/bin\/ms-recover"/);
    assert.match(pkg, /deploy\/systemd\/ms-recover@\.service"/);
  });

  it('is installed by every installer and listed by the rpm', () => {
    const setup = readFileSync(script('setup.sh'), 'utf8');
    assert.match(setup, /"\$\{UNIT_DIR\}\/ms-recover@\.service"/);
    const rpm = readFileSync(join(repoRoot, 'scripts', 'package-rpm.sh'), 'utf8');
    assert.match(rpm, /^\/usr\/lib\/systemd\/system\/ms-recover@\.service$/m);
  });
});

describe('who shows a passing check’s warnings (`H-27`)', () => {
  const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
  /** The `grep` that picks a check's warnings out of what it said. */
  const PICKS_WARNINGS = "grep '^warning: '";

  it('is ms-setup, in one place, and no other installer script', () => {
    assert.equal(count(read('deploy/setup.sh'), PICKS_WARNINGS), 1);
    for (const other of ['place-release.sh', 'install.sh', 'install-probe.sh']) {
      assert.equal(count(read(`deploy/${other}`), PICKS_WARNINGS), 0, other);
    }
  });

  it('is reached by both tarball installers, after the release is placed', () => {
    for (const installer of ['install.sh', 'install-probe.sh']) {
      const text = read(`deploy/${installer}`);
      const placed = text.indexOf('/deploy/place-release.sh" "$' + '{place_args[@]}"');
      const setup = text.indexOf('/libexec/ms-setup" "$' + '{setup_args[@]}"');
      assert.ok(placed >= 0, `${installer} does not place a release`);
      assert.ok(setup >= 0, `${installer} does not run ms-setup`);
      assert.ok(placed < setup, `${installer} runs ms-setup before the release is in`);
      assert.equal(count(text, '/libexec/ms-setup" '), 1, `${installer} runs ms-setup twice`);
    }
  });

  it('is all a package runs: once from the .deb’s postinst and once from the .rpm’s %post', () => {
    for (const [packager, scriptlet] of [
      ['scripts/package-deb.sh', /configure\)\n\s+\/opt\/ms\/libexec\/ms-setup --components /],
      ['scripts/package-rpm.sh', /%post\n(?:#.*\n)*\/opt\/ms\/libexec\/ms-setup --components /],
    ] as const) {
      const text = read(packager);
      assert.match(text, scriptlet, packager);
      assert.equal(count(text, '/opt/ms/libexec/ms-setup --'), 1, `${packager} runs it twice`);
      assert.doesNotMatch(text, /place-release/, `${packager} places a release as well`);
    }
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
        writeFileSync(join(prefix, 'bin', `ms-${svc}`), launcher(svc, '2.0.0'), { mode: 0o755 });
        writeFileSync(
          join(prefix, 'etc', `${svc}.json`),
          readFileSync(join(repoRoot, 'deploy', 'examples', `${svc}.json`)),
        );
        writeFileSync(
          join(prefix, 'deploy', 'systemd', `ms-${svc}.service`),
          readFileSync(join(repoRoot, 'deploy', 'systemd', `ms-${svc}.service`)),
        );
      }
      // What both units name in OnFailure= (`H-23`), shipped whichever of them a host runs.
      writeFileSync(
        join(prefix, 'deploy', 'systemd', 'ms-recover@.service'),
        readFileSync(join(repoRoot, 'deploy', 'systemd', 'ms-recover@.service')),
      );
      if (core !== null) writeFileSync(join(conf, 'core.json'), core);
      return { prefix, conf };
    }

    /**
     * Where setup reads and writes `net.ipv4.ping_group_range` (`H-31`), in the box: open to every
     * group, as Docker leaves it, unless a test has written something else there first.
     */
    function hostDirs(box: Sandbox): NodeJS.ProcessEnv {
      const range = join(box.dir, 'ping_group_range');
      if (!existsSync(range)) writeFileSync(range, '0\t2147483647\n');
      return {
        MS_SETUP_UNIT_DIR: join(box.dir, 'usr-lib-units'),
        MS_SETUP_LEGACY_UNIT_DIR: join(box.dir, 'etc-units'),
        MS_SETUP_PING_RANGE: range,
        MS_SETUP_SYSCTL_DIR: join(box.dir, 'sysctl.d'),
      };
    }

    function setup(
      box: Sandbox,
      prefix: string,
      conf: string,
      args: readonly string[],
      extra: NodeJS.ProcessEnv = {},
    ): SpawnSyncReturns<string> {
      return box.run([script('setup.sh'), '--prefix', prefix, '--confdir', conf, ...args], {
        ...hostDirs(box),
        ...extra,
      });
    }

    /** What an operator's core.json looks like to the stub launcher: one it accepts. */
    const CONFIGURED = '{"api":{"port":8080}}';

    it('moves a stock unit out of /etc, keeps an edited one, and reloads before it enables', () => {
      const box = sandbox();
      // An upgrade: an earlier release's units are here, and so is its configuration.
      const { prefix, conf } = installation(box, CONFIGURED);
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
      assert.doesNotMatch(result.stderr, /waits less than a second/);
      for (const svc of ['ms-core', 'ms-probe', 'ms-recover@']) {
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

    it('warns of a drop-in that restarts too soon for ms-recover to tell a crash loop (`H-23`)', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
        BUS_ms_probe_RestartUSec: '500000',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /ms-probe\.service waits less than a second before a restart/);
      assert.doesNotMatch(result.stderr, /ms-core\.service waits less than a second/);
    });

    it('on a refusal, has reloaded the units, starts nothing, and says what is running', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, '{"api":{"port":"refused-port"}}');
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
      const { prefix, conf } = installation(box, CONFIGURED);
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

    /** The lines under the heading for `file`, up to the next line that is not indented. */
    function saidOf(stderr: string, file: string, verdict: string): string[] {
      const said = stderr.split('\n');
      const heading = said.findIndex((line) => line.includes(`${file} ${verdict}`));
      assert.ok(heading >= 0, `no heading for ${file} ${verdict}:\n${stderr}`);
      const under: string[] = [];
      for (const line of said.slice(heading + 1)) {
        if (!line.startsWith('    ')) break;
        under.push(line);
      }
      return under;
    }

    it('shows the warnings of a check that passed, once, and starts the services (`H-27`)', () => {
      // What a .deb's postinst and an .rpm's %post run, and a person running ms-setup again:
      // this script and `--components`, with nothing before it.
      const box = sandbox();
      const { prefix, conf } = installation(box, '{"api":{"port":8080}}');
      // The probe's file and not the core's, so the heading has a file to get wrong.
      writeFileSync(join(conf, 'probe.json'), '{"flowListener":{"enabled":"no-effect-setting"}}');
      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

      // Every warning, each as the check wrote it, under a heading that names the file and the
      // version — on stderr, where the check put them.
      assert.match(
        result.stderr,
        /^==> .*etc-ms\/probe\.json is valid for 2\.0\.0\. The check says:$/m,
      );
      assert.deepEqual(saidOf(result.stderr, 'probe.json', 'is valid for 2.0.0'), [
        `    ${FIRST_WARNING}`,
        '    warning: a second thing ms-probe starts with',
      ]);
      // Once, on either stream.
      assert.equal(count(result.stdout + result.stderr, FIRST_WARNING), 1);
      assert.equal(count(result.stdout + result.stderr, 'is valid for 2.0.0'), 1);
      // And only the warnings: the rest of a pass is not news, marker in the middle or not.
      assert.doesNotMatch(result.stderr + result.stdout, /configuration is valid for/);
      assert.doesNotMatch(result.stderr + result.stdout, /MS_NOT_A_warning/);
      // Nothing is said about the file that had none, and nothing is refused.
      assert.doesNotMatch(result.stderr, /core\.json is valid/);
      assert.doesNotMatch(result.stderr, /not valid|does not load/);

      // The start is the one a silent pass gets.
      const log = box.logged();
      assert.ok(log.includes('systemctl restart ms-core.service'), log);
      assert.ok(log.includes('systemctl restart ms-probe.service'), log);
    });

    it('says nothing about a check that passed with nothing to say', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, '{"api":{"port":8080}}');
      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.ok(box.logged().includes('ms-core 2.0.0 config check --config'), box.logged());
      assert.doesNotMatch(result.stdout + result.stderr, /is valid for|warning: |The check says/);
    });

    it('shows a pass its warnings beside a refusal, and the refusal whole, each once', () => {
      const box = sandbox();
      const { prefix, conf } = installation(
        box,
        '{"api":{"port":"refused-port"},"x":"no-effect-setting"}',
      );
      writeFileSync(join(conf, 'probe.json'), '{"flowListener":{"enabled":"no-effect-setting"}}');
      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'inactive',
        STATE_ms_probe: 'inactive',
      });

      assert.equal(result.status, 1, 'a warning beside a refusal let the refusal through');
      // The refused file: the whole of what the check said, in the order it said it.
      assert.deepEqual(saidOf(result.stderr, 'core.json', 'is not valid for 2.0.0'), [
        `    ${FIRST_WARNING}`,
        '    warning: a second thing ms-core starts with',
        '    api.port: must be integer',
      ]);
      // The file that passed: its warnings and nothing else.
      assert.deepEqual(saidOf(result.stderr, 'probe.json', 'is valid for 2.0.0'), [
        `    ${FIRST_WARNING}`,
        '    warning: a second thing ms-probe starts with',
      ]);
      assert.equal(count(result.stderr, 'warning: a second thing ms-core'), 1);
      assert.equal(count(result.stderr, 'warning: a second thing ms-probe'), 1);
      assert.match(result.stderr, /does not load under 2\.0\.0, so nothing was started/);
      assert.ok(!box.logged().includes('restart'), 'something was started beside a refusal');
    });

    it('asks nothing and shows nothing where nothing is to be started', () => {
      // `--no-start`, and the variable a package's scriptlet is given in its place.
      for (const [args, extra] of [
        [['--components', 'core,probe', '--no-start'], {}],
        [['--components', 'core,probe'], { MS_SETUP_NO_START: '1' }],
      ] as const) {
        const box = sandbox();
        const { prefix, conf } = installation(box, '{"api":{"port":8080}}');
        writeFileSync(join(conf, 'probe.json'), '{"flowListener":{"enabled":"no-effect-setting"}}');
        const result = setup(box, prefix, conf, args, extra);
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.ok(!box.logged().includes('config check'), box.logged());
        assert.doesNotMatch(result.stdout + result.stderr, /warning: |is valid for/);
        assert.ok(!box.logged().includes('restart'), box.logged());
      }
    });

    it('shows a tarball upgrade each warning once, though the check is asked twice (`H-27`)', () => {
      // What `install.sh` and `install-probe.sh` run, in their order: `place-release.sh` from
      // the unpacked release, then the `ms-setup` it put under the prefix — this tree's
      // `setup.sh`, which is what a release ships.
      const box = sandbox();
      const { prefix, conf } = installed(box);
      writeFileSync(join(conf, 'probe.json'), '{"flowListener":{"enabled":"no-effect-setting"}}');
      const from = release(box, '2.0.0');
      writeFileSync(join(from, 'deploy', 'setup.sh'), readFileSync(script('setup.sh')));
      writeFileSync(
        join(from, 'deploy', 'systemd', 'ms-recover@.service'),
        readFileSync(join(repoRoot, 'deploy', 'systemd', 'ms-recover@.service')),
      );

      const placed = place(box, from, prefix, conf, '--components', 'core,probe');
      assert.equal(placed.status, 0, placed.stderr);
      const result = box.run(
        [
          join(prefix, 'libexec', 'ms-setup'),
          '--prefix',
          prefix,
          '--confdir',
          conf,
          '--components',
          'core,probe',
        ],
        {
          ...hostDirs(box),
          STATE_ms_core: 'active',
          STATE_ms_probe: 'active',
        },
      );
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

      // Both asked the new build about the probe's file, and it warned both times.
      assert.equal(count(box.logged(), 'ms-probe 2.0.0 config check --config'), 2, box.logged());
      // The operator saw one heading and each warning once, in everything both scripts wrote.
      const shown = placed.stdout + placed.stderr + result.stdout + result.stderr;
      assert.equal(count(shown, FIRST_WARNING), 1, shown);
      assert.equal(count(shown, 'warning: a second thing ms-probe starts with'), 1, shown);
      assert.equal(count(shown, 'probe.json is valid for 2.0.0'), 1, shown);
      assert.equal(placed.stderr, '', 'and it was not place-release.sh that showed it');
      assert.deepEqual(saidOf(result.stderr, 'probe.json', 'is valid for 2.0.0'), [
        `    ${FIRST_WARNING}`,
        '    warning: a second thing ms-probe starts with',
      ]);
      assert.ok(box.logged().includes('systemctl restart ms-probe.service'), box.logged());
    });

    it('lists the machine’s own name in a fresh core’s api.allowedHosts, and never an address (A-47)', () => {
      for (const [said, expected] of [
        ['MS-Core.Example.Net.', ['ms-core.example.net']],
        ['ms01', ['ms01']],
        ['10.0.0.5', []],
        ['localhost', []],
        ['not_a_name', []],
      ] as const) {
        const box = sandbox();
        // What `hostname -f` says on this machine, which is what an operator's browser will use.
        writeFileSync(join(box.bin, 'hostname'), `#!/usr/bin/env bash\necho '${said}'\n`, {
          mode: 0o755,
        });
        const { prefix, conf } = installation(box, null);
        const result = setup(box, prefix, conf, ['--components', 'core', '--no-start']);
        assert.equal(result.status, 0, `${said}: ${result.stdout}${result.stderr}`);
        const core = JSON.parse(readFileSync(join(conf, 'core.json'), 'utf8')) as {
          api: { allowedHosts?: string[] };
          probeEndpoint: { accessKeys: string[] };
        };
        assert.deepEqual(core.api.allowedHosts, expected, said);
        assert.equal(core.probeEndpoint.accessKeys.length, 1, 'and the access key, as before');
      }
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

    // --- a first installation (`H-30`) -------------------------------------------------------

    it('starts nothing on a first install, exits 0, and says what to set (`H-30`)', () => {
      // What a fresh `.deb`'s postinst, a fresh `.rpm`'s %post and a first `install.sh` run.
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const result = setup(box, prefix, conf, ['--components', 'core,probe']);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.ok(existsSync(join(conf, 'core.json')), 'core.json was not created');

      const log = box.logged();
      assert.ok(!log.includes('restart'), `something was started:\n${log}`);
      assert.ok(!log.includes('systemctl start'), `something was started:\n${log}`);
      // The units are in place and enabled all the same: the operator's next step is a start.
      assert.ok(log.includes('systemctl daemon-reload'), log);
      assert.ok(log.includes('systemctl enable ms-core.service'), log);
      assert.ok(log.includes('systemctl enable ms-probe.service'), log);

      for (const said of [
        'core.json is new, so nothing was started',
        'database.password',
        `${prefix}/bin/ms-core config check`,
        'systemctl reset-failed ms-core ms-probe',
        'systemctl start ms-core ms-probe',
        'MS_DATABASE__PASSWORD__FROM_FILE',
      ]) {
        assert.ok(
          result.stdout.includes(said),
          `the message does not say '${said}':\n${result.stdout}`,
        );
      }
      assert.doesNotMatch(result.stderr, /error|does not load/);
    });

    it('starts both on the run after, which is not a first install (`H-30`)', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const first = setup(box, prefix, conf, ['--components', 'core,probe']);
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      // The operator sets the password; the stub launcher accepts the file either way.
      const second = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
      });
      assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
      assert.doesNotMatch(second.stdout, /is new, so nothing was started/);
      const log = box.logged();
      assert.ok(log.includes('systemctl restart ms-core.service'), log);
      assert.ok(log.includes('systemctl restart ms-probe.service'), log);
    });

    it('judges a core.json that was already there by nothing in it, an empty password included', () => {
      // `LoadCredentialEncrypted=` and `*__FROM_FILE`: an empty password on purpose, which only
      // the unit can see past. So the shipped example, as an operator left it, is started.
      const box = sandbox();
      const example = readFileSync(join(repoRoot, 'deploy', 'examples', 'core.json'), 'utf8');
      assert.match(example, /"password": ""/);
      const { prefix, conf } = installation(box, example);
      const result = setup(box, prefix, conf, ['--components', 'core,probe'], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.doesNotMatch(result.stdout, /is new/);
      assert.ok(box.logged().includes('systemctl restart ms-core.service'), box.logged());
    });

    it('still refuses a re-run onto a configuration that does not load (`H-30` changes no other run)', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, '{"api":{"port":"refused-port"}}');
      const result = setup(box, prefix, conf, ['--components', 'core,probe']);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /is new/);
      assert.ok(!box.logged().includes('restart'), box.logged());
    });

    it('starts a probe-only first install as it always did: there is no core.json to create', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const result = setup(box, prefix, conf, ['--components', 'probe'], {
        STATE_ms_probe: 'active',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.doesNotMatch(result.stdout, /is new/);
      assert.ok(!existsSync(join(conf, 'core.json')));
      assert.ok(box.logged().includes('systemctl restart ms-probe.service'), box.logged());
    });

    // --- ICMP for the probe's group (`H-31`) -------------------------------------------------

    /** ms-probe's gid, once setup has created the group. */
    const probeGid = (): string =>
      (
        spawnSync('getent', ['group', 'ms-probe'], { encoding: 'utf8' }).stdout.split(':')[2] ?? ''
      ).trim();

    it('opens an empty ping_group_range to ms-probe’s group alone, now and at boot (`H-31`)', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const range = join(box.dir, 'ping_group_range');
      writeFileSync(range, '1\t0\n');
      const result = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

      const gid = probeGid();
      assert.match(gid, /^\d+$/);
      assert.equal(readFileSync(range, 'utf8'), `${gid}\t${gid}\n`, 'not applied now');
      const dropIn = join(box.dir, 'sysctl.d', '60-ms-probe-ping.conf');
      assert.match(
        readFileSync(dropIn, 'utf8'),
        new RegExp(`^net\\.ipv4\\.ping_group_range = ${gid} ${gid}$`, 'm'),
      );
      assert.equal(mode(dropIn), 0o644);
      assert.match(
        result.stdout,
        new RegExp(`ICMP sockets allowed for group ms-probe \\(gid ${gid}\\)`),
      );
    });

    it('leaves a range that already has the probe’s group, or one somebody set without it', () => {
      for (const [set, warned] of [
        ['0\t2147483647\n', false],
        ['0\t0\n', true],
      ] as const) {
        const box = sandbox();
        const { prefix, conf } = installation(box, null);
        const range = join(box.dir, 'ping_group_range');
        writeFileSync(range, set);
        const result = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.equal(readFileSync(range, 'utf8'), set, 'the range was changed');
        assert.ok(!existsSync(join(box.dir, 'sysctl.d', '60-ms-probe-ping.conf')), set);
        if (warned) {
          assert.match(result.stderr, /ping_group_range is 0-0, which leaves out group ms-probe/);
        } else {
          assert.doesNotMatch(result.stderr, /ping_group_range/);
        }
      }
    });

    it('touches no ICMP setting on a host with no probe, and warns of one it cannot read', () => {
      const coreOnly = sandbox();
      const core = installation(coreOnly, null);
      writeFileSync(join(coreOnly.dir, 'ping_group_range'), '1\t0\n');
      const result = setup(coreOnly, core.prefix, core.conf, [
        '--components',
        'core',
        '--no-start',
      ]);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(join(coreOnly.dir, 'ping_group_range'), 'utf8'), '1\t0\n');
      assert.ok(!existsSync(join(coreOnly.dir, 'sysctl.d')));

      const unreadable = sandbox();
      const probe = installation(unreadable, null);
      const missing = setup(
        unreadable,
        probe.prefix,
        probe.conf,
        ['--components', 'probe', '--no-start'],
        {
          MS_SETUP_PING_RANGE: join(unreadable.dir, 'no-such-file'),
        },
      );
      assert.equal(missing.status, 0, `${missing.stdout}${missing.stderr}`);
      assert.match(missing.stderr, /could not read net\.ipv4\.ping_group_range/);
    });

    it('writes a drop-in that a purge or an erase recognises as its own and removes (`H-34`)', () => {
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const range = join(box.dir, 'ping_group_range');
      writeFileSync(range, '1\t0\n');
      const result = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const dropIn = join(box.dir, 'sysctl.d', '60-ms-probe-ping.conf');
      assert.ok(existsSync(dropIn), 'setup wrote no drop-in, so this proves nothing');

      const removed = removePingConf(join(box.dir, 'sysctl.d'));
      assert.equal(removed.status, 0, removed.stderr);
      assert.ok(!existsSync(dropIn), `the drop-in setup wrote was kept:\n${removed.stderr}`);
      assert.match(removed.stderr, /removed .*60-ms-probe-ping\.conf, which ms-setup wrote/);
      const gid = probeGid();
      assert.equal(readFileSync(range, 'utf8'), `${gid}\t${gid}\n`, 'the live range was touched');
    });

    it('writes the drop-in again for a reinstall before the boot that would lose it (`H-34`)', () => {
      // A purge took the file and left the running range at the probe's group alone. Without the
      // file, the next boot puts `1 0` back and every ICMP sensor goes Down.
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const range = join(box.dir, 'ping_group_range');
      writeFileSync(range, '1\t0\n');
      const first = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      const dropIn = join(box.dir, 'sysctl.d', '60-ms-probe-ping.conf');
      const wrote = readFileSync(dropIn, 'utf8');
      const purged = removePingConf(join(box.dir, 'sysctl.d'));
      assert.ok(!existsSync(dropIn), purged.stderr);

      const again = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
      assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
      assert.equal(readFileSync(dropIn, 'utf8'), wrote, 'not written again, or not the same');
      assert.equal(mode(dropIn), 0o644);
      assert.match(again.stdout, /nothing kept that for the next boot: written again in /);
      const gid = probeGid();
      assert.equal(readFileSync(range, 'utf8'), `${gid}\t${gid}\n`);

      // A drop-in that is there is left as it is, edited or not, and so is any other range that
      // includes the group: those are somebody's.
      const edited = `${wrote}# and the backup host's\n`;
      writeFileSync(dropIn, edited);
      const kept = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
      assert.equal(kept.status, 0, `${kept.stdout}${kept.stderr}`);
      assert.equal(readFileSync(dropIn, 'utf8'), edited);
      assert.doesNotMatch(kept.stdout, /written again/);
      for (const other of [`0\t${gid}\n`, `${gid}\t${String(Number(gid) + 1)}\n`]) {
        rmSync(dropIn, { force: true });
        writeFileSync(range, other);
        const theirs = setup(box, prefix, conf, ['--components', 'core,probe', '--no-start']);
        assert.equal(theirs.status, 0, `${theirs.stdout}${theirs.stderr}`);
        assert.ok(!existsSync(dropIn), `written for a range somebody set: ${other}`);
      }
    });

    // --- what it tells the installer that ran it (`H-35`) -----------------------------------

    it('tells its caller what it did with the services, and nothing when it failed (`H-35`)', () => {
      const said = (box: Sandbox): string | null => {
        const file = join(box.dir, 'outcome');
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
      };
      const outcome = (box: Sandbox): string[] => ['--outcome', join(box.dir, 'outcome')];

      // A first installation: core.json is created, nothing is started.
      const box = sandbox();
      const { prefix, conf } = installation(box, null);
      const first = setup(box, prefix, conf, ['--components', 'core,probe', ...outcome(box)]);
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      assert.equal(said(box), 'first-install\n');

      // The run after it, an upgrade: both started.
      const again = setup(box, prefix, conf, ['--components', 'core,probe', ...outcome(box)], {
        STATE_ms_core: 'active',
        STATE_ms_probe: 'active',
      });
      assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
      assert.equal(said(box), 'started\n');

      // Asked not to start, by the flag or by the variable: a first installation is still one,
      // since its core.json has no password whatever stopped the start.
      for (const [args, extra, core, expected] of [
        [['--no-start'], {}, null, 'first-install\n'],
        [[], { MS_SETUP_NO_START: '1' }, null, 'first-install\n'],
        [['--no-start'], {}, CONFIGURED, 'not-started\n'],
        [[], { MS_SETUP_NO_START: '1' }, CONFIGURED, 'not-started\n'],
      ] as const) {
        const staged = sandbox();
        const where = installation(staged, core);
        const result = setup(
          staged,
          where.prefix,
          where.conf,
          ['--components', 'core,probe', ...args, ...outcome(staged)],
          extra,
        );
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.equal(said(staged), expected, `${args.join(' ')} ${String(core)}`);
        assert.ok(!staged.logged().includes('restart'), staged.logged());
      }

      // A refusal and a failed start say nothing, so no caller can claim a start.
      for (const [core, extra] of [
        ['{"api":{"port":"refused-port"}}', {}],
        [CONFIGURED, { FAIL_RESTART: 'ms-core' }],
      ] as const) {
        const failed = sandbox();
        const where = installation(failed, core);
        const result = setup(
          failed,
          where.prefix,
          where.conf,
          ['--components', 'core,probe', ...outcome(failed)],
          extra,
        );
        assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
        assert.equal(said(failed), null, core);
      }
    });
  },
);

/** The one line in `remove-ping-conf.sh` that says where an installed probe's tree would be. */
const PING_SETUP_LINE = 'ms_ping_setup=/opt/ms/libexec/ms-setup\n';

/**
 * `remove-ping-conf.sh` as a postrm runs it: `/bin/sh`, `set -e`, the drop-in in `dir`. Where it
 * looks for an installed ms or ms-probe is moved into `dir` too, so that what the machine running
 * the tests has under /opt/ms cannot decide the answer; `sibling` puts one there. `bin` goes on the
 * front of PATH, for a stub.
 */
function removePingConf(
  dir: string,
  { sibling = false, bin }: { sibling?: boolean; bin?: string } = {},
): SpawnSyncReturns<string> {
  const text = readFileSync(script('remove-ping-conf.sh'), 'utf8');
  assert.equal(count(text, PING_SETUP_LINE), 1, 'the fragment does not name /opt/ms once');
  const setupPath = join(dir, 'opt-ms-libexec-ms-setup');
  if (sibling) writeFileSync(setupPath, '#!/bin/sh\n', { mode: 0o755 });
  const path = process.env['PATH'] ?? '/usr/bin:/bin';
  return spawnSync(
    'sh',
    ['-e', '-c', text.replace(PING_SETUP_LINE, `ms_ping_setup=${setupPath}\n`)],
    {
      env: { PATH: bin === undefined ? path : `${bin}:${path}`, MS_SETUP_SYSCTL_DIR: dir },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

describe(
  'the ping drop-in a purge or an erase takes away (`H-34`)',
  {
    skip: linux ? false : 'Linux only',
  },
  () => {
    /** What setup.sh writes for `gid`, from setup.sh itself, so the two cannot drift apart. */
    const written = (gid: number): string => {
      const found = /<<SYSCTL\n([\s\S]*?\n)SYSCTL\n/u.exec(
        readFileSync(script('setup.sh'), 'utf8'),
      );
      assert.ok(found?.[1] !== undefined, 'setup.sh writes no drop-in this test can find');
      return found[1].replaceAll('$' + '{probe_gid}', String(gid));
    };
    /** What the release candidates wrote (`H-31`), which installations have and keep having. */
    const WRITTEN_BY_RC = (gid: number): string =>
      '# Written by ms-setup (MonitoringSystem). Lets the ms-probe group, and only it, open the\n' +
      '# unprivileged ICMP sockets its ping sensors use; ms-probe.service gives the probe no\n' +
      '# CAP_NET_RAW. See "Before you start" in /opt/ms/docs/installation.md.\n' +
      `net.ipv4.ping_group_range = ${String(gid)} ${String(gid)}\n`;

    function withDropIn(text: string): { dir: string; file: string } {
      const dir = mkdtempSync(join(tmpdir(), 'ms-sysctl-'));
      const file = join(dir, '60-ms-probe-ping.conf');
      writeFileSync(file, text);
      return { dir, file };
    }

    it('removes the file ms-setup wrote, today’s and the release candidates’, whatever the gid', () => {
      for (const text of [written(998), written(1234567), WRITTEN_BY_RC(999), WRITTEN_BY_RC(0)]) {
        const { dir, file } = withDropIn(text);
        const result = removePingConf(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(!existsSync(file), `kept:\n${text}\n${result.stderr}`);
        assert.match(result.stderr, /which ms-setup wrote; the running kernel's/);
        assert.match(result.stderr, /left as it is until the next boot/);
        assert.equal(result.stdout, '');
      }
    });

    it('keeps one that was edited, and says so', () => {
      const base = WRITTEN_BY_RC(998);
      for (const [why, text] of [
        ['a line added', `${base}# and kept for the backup host's checks\n`],
        ['widened', base.replace('= 998 998', '= 998 1001')],
        ['moved to another group', base.replace('= 998 998', '= 0 2147483647')],
        ['no range at all', base.replace(/^net\..*\n/mu, '')],
        ['a comment reworded', base.replace('Written by ms-setup', 'Written by hand')],
        ['a line taken out', base.replace(/^# CAP_NET_RAW.*\n/mu, '')],
        ['a gid that is not a number', base.replaceAll('998', 'ms-probe')],
        ['the range twice', `${base}net.ipv4.ping_group_range = 998 998\n`],
        ['no group in the range', base.replace('= 998 998', '=  ')],
      ] as const) {
        const { dir, file } = withDropIn(text);
        const result = removePingConf(dir);
        assert.equal(result.status, 0, `${why}: ${result.stderr}`);
        assert.equal(readFileSync(file, 'utf8'), text, `${why}: the file was changed or removed`);
        assert.match(
          result.stderr,
          /60-ms-probe-ping\.conf is not as ms-setup wrote it, so it was left in place/,
          why,
        );
      }
    });

    it('keeps a link in its place, and the file it points at', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ms-sysctl-'));
      const file = join(dir, '60-ms-probe-ping.conf');
      const target = join(dir, 'elsewhere.conf');
      writeFileSync(target, WRITTEN_BY_RC(998));
      symlinkSync(target, file);
      const result = removePingConf(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(lstatSync(file).isSymbolicLink(), 'the link was replaced');
      assert.equal(readFileSync(target, 'utf8'), WRITTEN_BY_RC(998));
      assert.match(result.stderr, /left in place/);
    });

    it('leaves the file for a probe still installed: ms purged after a switch to ms-probe', () => {
      // dpkg: `ms` removed for `ms-probe`, left in `rc`, purged later. rpm: `dnf swap`, whose
      // erase of `ms` comes after `ms-probe` is in. Either way /opt/ms is the other package's.
      for (const text of [written(998), WRITTEN_BY_RC(998)]) {
        const { dir, file } = withDropIn(text);
        const result = removePingConf(dir, { sibling: true });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(file, 'utf8'), text, 'the installed probe lost its drop-in');
        assert.match(result.stderr, /was left in place: .*ms-setup is still installed/);
        assert.match(result.stderr, /\(ms or ms-probe\), and the probe it runs needs the file/);
      }
      // And with no file, nothing to say.
      const dir = mkdtempSync(join(tmpdir(), 'ms-sysctl-'));
      const quiet = removePingConf(dir, { sibling: true });
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.equal(quiet.stdout + quiet.stderr, '');
    });

    it('never fails the scriptlet when the file cannot be removed (chattr +i, read-only /etc)', () => {
      const { dir, file } = withDropIn(WRITTEN_BY_RC(998));
      const bin = mkdtempSync(join(tmpdir(), 'ms-stub-rm-'));
      writeFileSync(
        join(bin, 'rm'),
        '#!/bin/sh\necho "rm: cannot remove \'$2\': Operation not permitted" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const result = removePingConf(dir, { bin });
      assert.equal(result.status, 0, `the postrm would have failed:\n${result.stderr}`);
      assert.ok(existsSync(file));
      assert.match(result.stderr, /Operation not permitted/);
      assert.match(
        result.stderr,
        /could not remove .*60-ms-probe-ping\.conf, which ms-setup wrote/,
      );
      assert.doesNotMatch(result.stderr, /note: removed/);
    });

    it('says nothing where there is no file: most hosts, every EL9 one', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ms-sysctl-'));
      const result = removePingConf(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout + result.stderr, '');
    });

    it('is carried by the .deb’s purge and the .rpm’s erase, and by nothing else', () => {
      const text = readFileSync(script('remove-ping-conf.sh'), 'utf8');
      assert.ok(!text.includes('%'), 'rpm reads a percent sign in a scriptlet as a macro');
      const embed = '$(cat "$' + '{repo_root}/deploy/remove-ping-conf.sh")';
      for (const [packager, branch] of [
        ['scripts/package-deb.sh', 'if [ "\\$1" = purge ]; then\n'],
        [
          'scripts/package-rpm.sh',
          'if [ "\\$1" -eq 0 ]; then\n  systemctl daemon-reload >/dev/null 2>&1 || :\n',
        ],
      ] as const) {
        const source = readFileSync(join(repoRoot, packager), 'utf8');
        assert.equal(count(source, embed), 1, packager);
        assert.ok(source.includes(`${branch}${embed}\n`), `${packager}: not inside ${branch}`);
      }
    });
  },
);

describe('install.sh’s closing summary (`H-35`)', { skip: linux ? false : 'Linux only' }, () => {
  /**
   * An unpacked release whose `place-release.sh` does nothing and whose `ms-setup` says what
   * `STUB_OUTCOME` says, as the real one does: one word, into the file `--outcome` names.
   */
  function run(
    args: readonly string[],
    outcome: string | null,
  ): { result: SpawnSyncReturns<string>; box: Sandbox } {
    const box = sandbox();
    const from = join(box.dir, 'release');
    const prefix = join(box.dir, 'opt-ms');
    mkdirSync(join(from, 'deploy'), { recursive: true });
    mkdirSync(join(prefix, 'libexec'), { recursive: true });
    writeFileSync(join(from, 'VERSION'), '2.0.0\n');
    writeFileSync(join(from, 'install.sh'), readFileSync(script('install.sh')), { mode: 0o755 });
    writeFileSync(join(from, 'deploy', 'place-release.sh'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(prefix, 'libexec', 'ms-setup'),
      [
        '#!/usr/bin/env bash',
        'echo "ms-setup $*" >> "$STUB_LOG"',
        'while [ "$#" -gt 0 ]; do',
        '  [ "$1" = --outcome ] && { echo "$2" > "$STUB_DIR/outcome-path"; out="$2"; }',
        '  shift',
        'done',
        '[ -z "${STUB_OUTCOME:-}" ] || echo "$STUB_OUTCOME" > "$out"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    // A host has these; the toolchain need not.
    for (const name of ['ping', 'openssl']) {
      writeFileSync(join(box.bin, name), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    }
    const result = box.run([join(from, 'install.sh'), '--prefix', prefix, ...args], {
      TMPDIR: box.dir,
      ...(outcome === null ? {} : { STUB_OUTCOME: outcome }),
    });
    return { result, box };
  }

  const FIRST_NOTE = 'This is a first installation, so nothing was started';

  const PASSWORD_NOTE = `${FIRST_NOTE}: /etc/ms/core.json is new and has\nno database password yet.`;

  it('gives the first-installation note to a first installation, and to nothing else', () => {
    const { result } = run([], 'first-install');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes(PASSWORD_NOTE), result.stdout);
    assert.match(
      result.stdout,
      /^ {2}services {8}ms-core ms-probe: not started, a first installation/m,
    );
    assert.match(result.stdout, /^ {2}systemctl reset-failed ms-core ms-probe$/m);
    assert.match(result.stdout, /^ {2}systemctl start ms-core ms-probe$/m);
  });

  it('gives a first installation under --no-start the password note as well', () => {
    // ms-setup says nothing of the password under --no-start, so this is the only place it is said.
    const { result, box } = run(['--no-start'], 'first-install');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(box.logged(), /^ms-setup .* --no-start$/m);
    assert.ok(result.stdout.includes(PASSWORD_NOTE), result.stdout);
    assert.ok(
      result.stdout.includes(
        '  services        ms-core ms-probe: not started (--no-start), and a first installation (below)\n',
      ),
      result.stdout,
    );
    assert.match(result.stdout, /^ {2}systemctl reset-failed ms-core ms-probe$/m);
    assert.match(result.stdout, /^ {2}systemctl start ms-core ms-probe$/m);
  });

  it('says an upgrade started the services, with no note about a first installation', () => {
    for (const [args, services] of [
      [[], 'ms-core ms-probe'],
      [['--core-only'], 'ms-core'],
      [['--probe-only'], 'ms-probe'],
    ] as const) {
      const { result } = run(args, 'started');
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.ok(
        result.stdout.includes(`  services        ${services}: started\n`),
        `${args.join(' ')}:\n${result.stdout}`,
      );
      assert.doesNotMatch(result.stdout, /first installation|nothing was started|systemctl start/);
    }
  });

  it('says --no-start started nothing because it was asked, and how to start them', () => {
    const { result, box } = run(['--no-start'], 'not-started');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(box.logged(), /^ms-setup .* --no-start$/m);
    assert.ok(
      result.stdout.includes('  services        ms-core ms-probe: not started (--no-start)\n'),
    );
    assert.match(result.stdout, /^ {2}systemctl start ms-core ms-probe$/m);
    assert.doesNotMatch(result.stdout, /first installation/);
  });

  it('claims nothing when ms-setup said nothing, and leaves no file behind', () => {
    const { result, box } = run([], null);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes('  services        as ms-setup said above\n'), result.stdout);
    assert.doesNotMatch(result.stdout, /first installation|: started|systemctl start/);
    // ms-setup was given a file, and install.sh took it away again.
    const path = readFileSync(join(box.dir, 'outcome-path'), 'utf8').trim();
    assert.ok(path.startsWith(box.dir), path);
    assert.ok(!existsSync(path), `${path} was left behind`);
  });
});

describe('the MS_* variables the product sets itself, and who reports them (`H-32`)', () => {
  const sections = new Set(
    [coreConfigSchema, probeConfigSchema].flatMap((schema) =>
      Object.keys((schema as { properties?: object }).properties ?? {}),
    ),
  );
  /** Whether the loader reads `name` as a setting: its first segment, camel-cased, is a section. */
  const isSetting = (name: string): boolean => {
    const first = (
      name
        .slice('MS_'.length)
        .replace(/__FROM_FILE$/u, '')
        .split('__')[0] ?? ''
    )
      .toLowerCase()
      .replace(/_([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase());
    return sections.has(first);
  };
  const namesIn = (text: string): Set<string> =>
    new Set(text.match(/\bMS_[A-Z][A-Z0-9_]*/gu) ?? []);
  const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
  /** Every file under a directory, relative to the repository. */
  const filesUnder = (dir: string): string[] =>
    readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(repoRoot.length + 1));
  /** Every service's own source, and nothing compiled or installed. */
  const sourceFiles = (): string[] =>
    readdirSync(join(repoRoot, 'packages'))
      .filter((pkg) => existsSync(join(repoRoot, 'packages', pkg, 'src')))
      .flatMap((pkg) => filesUnder(join('packages', pkg, 'src')));
  /** The launcher `package.sh` writes for each service, exactly as the heredoc has it. */
  const launcher = (): string => {
    const found = /<<LAUNCHER\n([\s\S]*?)\nLAUNCHER\n/u.exec(read('scripts/package.sh'));
    assert.ok(found?.[1] !== undefined, 'package.sh writes no launcher this test can find');
    return found[1];
  };

  it('lists every one the launchers, the units and the installers set or read', () => {
    const sources = new Map<string, string>([['the launcher in package.sh', launcher()]]);
    for (const file of filesUnder('deploy')) sources.set(file, read(file));
    // So that a scan that found nothing cannot pass.
    assert.ok(namesIn(launcher()).has('MS_BUILD_VERSION'));
    assert.ok(sources.has('deploy/setup.sh') && sources.has('deploy/systemd/ms-core.service'));
    for (const [where, text] of sources) {
      for (const name of namesIn(text)) {
        if (isSetting(name)) continue;
        assert.ok(
          PRODUCT_ENV.has(name),
          `${name}, in ${where}, is neither a setting nor in PRODUCT_ENV, so every ` +
            'installation would report it as ignored',
        );
      }
    }
  });

  it('lists every one a service hands to its workers', () => {
    const handed = sourceFiles()
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => [...read(file).matchAll(/\bconst \w+_ENV = '(MS_[A-Z0-9_]+)'/gu)])
      .map((match) => match[1] ?? '');
    assert.ok(handed.includes('MS_TARGET_POLICY'), handed.join(', '));
    for (const name of handed) assert.ok(PRODUCT_ENV.has(name), name);
  });

  it('lists nothing that nothing sets or reads', () => {
    const used = namesIn(
      [
        read('scripts/package.sh'),
        ...filesUnder('deploy').map(read),
        ...sourceFiles()
          .filter((file) => !file.endsWith(join('config', 'product-env.ts')))
          .map(read),
      ].join('\n'),
    );
    for (const name of PRODUCT_ENV.keys()) {
      assert.ok(used.has(name), `${name} is in PRODUCT_ENV and nothing uses it`);
    }
  });
});
