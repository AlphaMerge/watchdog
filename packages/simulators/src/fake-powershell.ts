import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A PowerShell that is not PowerShell (`T-09`).
 *
 * **Why this exists rather than a mocked `runProgram`.** Everything worth getting wrong in this
 * transport is at the process boundary: whether the script reaches stdin instead of argv,
 * whether the password reaches the environment instead of either, whether a timeout kills, and
 * whether the marker is found in output that has other things in it. A mock at the function
 * boundary asserts none of that — it asserts that the code calls the function the tests said it
 * would call.
 *
 * It reads the wrapped script from stdin exactly as `powershell -Command -` does, finds a
 * `#FAKE:` directive in the body the transport embedded, and behaves like the corresponding
 * PowerShell would. It never interprets PowerShell: the sensors' snippets are exercised against
 * *recorded real output* instead, which is the only honest way to test a language this process
 * cannot run.
 */

const SOURCE = `#!/usr/bin/env node
const MARKER = '<<<ms-result>>>';

// -EncodedCommand is base64 of UTF-16LE, which is how PowerShell takes a script that is not a
// file — and, since a real pwsh proved it, the only form that runs a multi-line script the same
// way on 5.1 and 7. Decoding it here rather than accepting whatever argv holds is the point: the
// transport has to encode correctly or this reads nothing.
const at = process.argv.indexOf('-EncodedCommand');
const script =
  at < 0 ? '' : Buffer.from(process.argv[at + 1] || '', 'base64').toString('utf16le');
run(script);

function say(payload) {
  process.stdout.write(MARKER + JSON.stringify(payload) + '\\n');
}

function run(text) {
  // The directive may ride in the script the transport embedded, or in MS_WIN_HOST — which is
  // how a sensor whose snippet mentions nothing test-specific gets a canned answer, since the
  // machine name is the one thing every Windows sensor puts somewhere the child can see.
  const where = text + '\\n' + (process.env.MS_WIN_HOST || '');
  const directive = /#FAKE:(\\w+)(?:[ \\t]+(.*))?/.exec(where);
  const what = directive ? directive[1] : 'ok';
  const rest = (directive && directive[2] ? directive[2] : '').trim();

  switch (what) {
    case 'ok':
      say({ ok: true, data: rest === '' ? null : JSON.parse(rest) });
      return;
    case 'error':
      // What the wrapper's own catch block produces, so the transport meets the shape it will
      // meet in the field rather than one invented here. The category comes from the directive
      // rather than from an environment variable, because the transport states the child's whole
      // environment — which is a property this file's own tests assert.
      {
        const [category, message] = rest.includes('|')
          ? [rest.slice(0, rest.indexOf('|')), rest.slice(rest.indexOf('|') + 1)]
          : ['NotSpecified', rest];
        say({
          ok: false,
          error: message || 'something went wrong',
          category,
          type: 'System.Exception',
        });
      }
      return;
    case 'noise':
      // A profile banner, a module's chatter, and a line that *looks* like a result. The real
      // answer is last, which is the rule the transport is meant to follow.
      process.stdout.write('Windows PowerShell\\nCopyright (C) Microsoft Corporation.\\n\\n');
      process.stdout.write(MARKER + JSON.stringify({ ok: true, data: { decoy: true } }) + '\\n');
      process.stderr.write('WARNING: a module said something\\n');
      say({ ok: true, data: JSON.parse(rest || '{"real":true}') });
      return;
    case 'env':
      say({
        ok: true,
        data: {
          host: process.env.MS_WIN_HOST ?? null,
          user: process.env.MS_WIN_USER ?? null,
          password: process.env.MS_WIN_PASSWORD ?? null,
          auth: process.env.MS_WIN_AUTH ?? null,
          match: process.env.MS_WIN_MATCH ?? null,
          leaked: process.env.MS_SECRET_FROM_PARENT ?? null,
          argv: process.argv.slice(2, 5),
          script: text,
        },
      });
      return;
    case 'service':
      // What Win32_Service answers for the name a query carried in MS_WIN_MATCH (\`S-21\`), and
      // nothing for one it did not, as for a name spliced into the script instead. DisplayName
      // says whether the name is in the script text as well, which it must never be.
      {
        const name = process.env.MS_WIN_MATCH;
        say({
          ok: true,
          data:
            name === undefined
              ? []
              : [
                  {
                    Name: name,
                    DisplayName: text.includes(name) ? 'Spliced' : 'Held apart',
                    State: 'Running',
                    StartMode: 'Auto',
                    Status: 'OK',
                    ProcessId: 4242,
                  },
                ],
        });
      }
      return;
    case 'badjson':
      process.stdout.write(MARKER + '{not json at all\\n');
      return;
    case 'silent':
      // Exits cleanly having printed nothing, which is what a script killed by a policy or a
      // \`exit\` in the middle looks like.
      return;
    case 'crash':
      process.stderr.write(rest || 'The term is not recognized as a cmdlet.\\n');
      process.exit(1);
      return;
    case 'flood':
      for (let at = 0; at < 40_000; at += 1) process.stdout.write('x'.repeat(64) + '\\n');
      say({ ok: true, data: { flooded: true } });
      return;
    case 'hang':
      setInterval(() => undefined, 1_000);
      return;
    default:
      say({ ok: false, error: \`the fake does not know "\${what}"\`, category: 'NotSpecified' });
  }
}
`;

/**
 * Writes the fake out and returns its path.
 *
 * Written at test time rather than shipped as a file beside this one, because the suite runs
 * from `dist/` and `tsc` compiles TypeScript rather than copying JavaScript — a fixture that
 * lived next to the source would simply not be there. `T-19`'s script tests write their
 * programs the same way, for the same reason.
 */
export function installFakePowerShell(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ms-fake-ps-'));
  const path = join(dir, 'fake-powershell.js');
  writeFileSync(path, SOURCE, 'utf8');
  chmodSync(path, 0o755);
  return path;
}
