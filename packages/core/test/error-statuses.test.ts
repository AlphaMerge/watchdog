import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { AppError, IpRangeError } from '@ms/shared';
import { APP_ERROR_STATUS, toHttpError } from '../src/api/errors.js';

/**
 * Every `AppError` code the core can throw answers a status that somebody chose (`P-221`).
 *
 * `toHttpError` has a branch for each error class that carries its own status. Anything else
 * used to fall through to a 500 with the message replaced. A plain `AppError` saying
 * `DEVICE_TEMPLATE_NOT_FOUND` therefore reached the client as "the request could not be
 * completed": a client's mistake reported as the server's fault, and counted in every 5xx rate.
 *
 * **Read out of the source, because the failure is a code nobody listed.** A table can only be
 * checked against a list, and the list is whatever `throw` statements exist today. This file
 * finds each of them:
 * - every plain `new AppError('CODE', …)`;
 * - every subclass of `AppError` with no branch of its own, and the code it passes to `super`.
 *
 * It compares those codes with `APP_ERROR_STATUS` in both directions. A code this test cannot
 * read, such as one passed as a variable, fails it rather than escaping it.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCES = ['packages/core/src', 'packages/shared/src', 'packages/sensors/src'];
const MASKED = 'the request could not be completed';

interface Source {
  readonly file: string;
  readonly text: string;
}

async function sources(): Promise<Source[]> {
  const found: Source[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts')) {
        found.push({ file: relative(repoRoot, path), text: await readFile(path, 'utf8') });
      }
    }
  };
  for (const root of SOURCES) await walk(join(repoRoot, root));
  return found;
}

interface Thrown {
  /** Code to where it is thrown, for the failure message. */
  readonly codes: ReadonlyMap<string, string>;
  /** Places a code is passed that this test cannot read. */
  readonly unread: readonly string[];
}

/** Every code the core can throw that no branch of `toHttpError` answers. */
function thrown(all: readonly Source[], errors: string): Thrown {
  const codes = new Map<string, string>();
  const unread: string[] = [];

  // The family: every class that extends `AppError`, however many steps removed.
  const parents = new Map<string, { parent: string; source: Source; at: number }>();
  for (const source of all) {
    for (const match of source.text.matchAll(/class (\w+) extends (\w+)/gu)) {
      const [, name = '', parent = ''] = match;
      parents.set(name, { parent, source, at: match.index });
    }
  }
  const lineage = (name: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = name; at !== undefined && at !== 'AppError';) {
      chain.push(at);
      at = parents.get(at)?.parent;
    }
    return chain;
  };
  const inFamily = (name: string): boolean => {
    let at: string | undefined = name;
    while (at !== undefined) {
      if (at === 'AppError') return true;
      at = parents.get(at)?.parent;
    }
    return false;
  };
  const branched = (name: string): boolean => new RegExp(`instanceof ${name}\\b`, 'u').test(errors);

  for (const [name, { source, at }] of parents) {
    if (name === 'AppError' || !inFamily(name)) continue;
    // A branch for the class or any class above it answers it, with a status of its own.
    if (lineage(name).some(branched)) continue;
    // Otherwise its code is whatever it hands to `super`, and it has to be a literal.
    const body = source.text.slice(at, source.text.indexOf('\n}', at));
    const literal = /super\(\s*'([A-Z][A-Z0-9_]*)'/u.exec(body);
    if (literal?.[1] === undefined) {
      unread.push(`${name} in ${source.file} passes super a code this test cannot read`);
      continue;
    }
    codes.set(literal[1], `${name} (${source.file})`);
  }

  for (const source of all) {
    for (const match of source.text.matchAll(/new AppError\(\s*([^,)]*)/gu)) {
      const argument = (match[1] ?? '').trim();
      const literal = /^'([A-Z][A-Z0-9_]*)'$/u.exec(argument);
      if (literal?.[1] === undefined) {
        unread.push(`new AppError(${argument}, …) in ${source.file}`);
        continue;
      }
      codes.set(literal[1], `new AppError (${source.file})`);
    }
  }
  return { codes, unread };
}

describe('the status of every AppError code (`P-221`)', () => {
  it('names every code the core can throw, and nothing it cannot', async () => {
    const all = await sources();
    const errors = all.find((source) => source.file.endsWith('core/src/api/errors.ts'));
    assert.ok(errors, 'no packages/core/src/api/errors.ts');
    const { codes, unread } = thrown(all, errors.text);

    assert.deepEqual(unread, [], 'codes this test cannot read — pass a literal, or add a branch');
    const unlisted = [...codes].filter(([code]) => !APP_ERROR_STATUS.has(code));
    assert.deepEqual(
      unlisted.map(([code, where]) => `${code}, from ${where}`),
      [],
      'AppError codes with no status of their own reach the client as a masked 500. Give each ' +
        'one an entry in APP_ERROR_STATUS (packages/core/src/api/errors.ts), or a branch.',
    );
    const stale = [...APP_ERROR_STATUS.keys()].filter((code) => !codes.has(code));
    assert.deepEqual(stale, [], 'APP_ERROR_STATUS names codes nothing throws any more');
  });

  it('answers each with its status, and its sentence only where the table says so', () => {
    for (const [code, answer] of APP_ERROR_STATUS) {
      const { status, body } = toHttpError(new AppError(code, 'why it failed'), 'id');
      assert.equal(status, answer.status, code);
      assert.equal(body.error.code, code);
      assert.equal(body.error.message, answer.says ? 'why it failed' : MASKED, code);
      // A 4xx is always the caller's, so it always says why.
      if (answer.status < 500) assert.equal(answer.says, true, `${code} refuses and says nothing`);
    }
  });

  it('answers a subclass by the same table', () => {
    const { status, body } = toHttpError(new IpRangeError('"10.0.0.0/33" has a prefix longer'));
    assert.equal(status, 400);
    assert.equal(body.error.message, '"10.0.0.0/33" has a prefix longer');
  });

  it('still masks a code nobody listed, as the server’s fault', () => {
    const { status, body } = toHttpError(new AppError('NOBODY_LISTED_THIS', 'a path, a key id'));
    assert.equal(status, 500);
    assert.equal(body.error.message, MASKED);
  });
});
