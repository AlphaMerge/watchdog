import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/main.js';

describe('command line parsing', () => {
  it('runs the server when no subcommand is given', () => {
    assert.equal(parseArgs([]).command, 'serve');
    assert.equal(parseArgs(['--config', '/etc/ms/core.json']).command, 'serve');
  });

  it('does not mistake a flag value for a subcommand', () => {
    // Regression: `--config dev/core.json migrate status` started the server, because the
    // config path was read as the first positional argument.
    const parsed = parseArgs(['--config', 'dev/core.json', 'migrate', 'status']);
    assert.equal(parsed.command, 'migrate');
    assert.equal(parsed.migrateAction, 'status');
  });

  it('accepts the subcommand before or after the flags', () => {
    assert.equal(parseArgs(['migrate', 'up', '--config', 'x.json']).migrateAction, 'up');
    assert.equal(parseArgs(['--config', 'x.json', 'migrate', 'up']).migrateAction, 'up');
  });

  it('defaults migrate to status and down to a single step', () => {
    assert.equal(parseArgs(['migrate']).migrateAction, 'status');
    assert.equal(parseArgs(['migrate', 'down']).steps, 1);
    assert.equal(parseArgs(['migrate', 'down', '--steps', '3']).steps, 3);
  });

  it('ignores a nonsensical step count rather than reverting everything', () => {
    assert.equal(parseArgs(['migrate', 'down', '--steps', '0']).steps, 1);
    assert.equal(parseArgs(['migrate', 'down', '--steps', '-5']).steps, 1);
    assert.equal(parseArgs(['migrate', 'down', '--steps', 'lots']).steps, 1);
  });

  it('recognises the configuration check, before or after the flags', () => {
    // `install.sh` runs this against a live installation's config with the *new* build, before
    // it restarts anything (`H-03`). Mistaking it for the server would start a second core.
    assert.equal(parseArgs(['config', 'check']).command, 'config-check');
    assert.equal(
      parseArgs(['--config', '/etc/ms/core.json', 'config', 'check']).command,
      'config-check',
    );
    assert.equal(
      parseArgs(['config', 'check', '--config', '/etc/ms/core.json']).command,
      'config-check',
    );
  });

  it('refuses a mistyped config verb rather than starting the server', () => {
    // The failure that matters: `ms-core config chekc` binding a port on a machine that already
    // has a core running on it.
    assert.equal(parseArgs(['config', 'chekc']).command, 'help');
    assert.equal(parseArgs(['config']).command, 'help');
  });

  it('shows help for an unrecognised migrate action', () => {
    assert.equal(parseArgs(['migrate', 'sideways']).command, 'help');
    assert.equal(parseArgs(['--help']).command, 'help');
    assert.equal(parseArgs(['-h']).command, 'help');
  });
});
