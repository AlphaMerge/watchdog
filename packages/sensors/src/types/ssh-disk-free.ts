import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';
import { sshParamsSchema } from '../support/ssh/schema.js';

/**
 * Free space on one filesystem, over SSH (`T-08`).
 *
 * The same four channels as `snmp.diskfree`, on purpose: an operator watching a Linux box over
 * SSH and a switch over SNMP should not have to learn two vocabularies for "how full is it", and
 * a summary graph across both should line up.
 *
 * **`df -P -k` and nothing else.** `-P` is not optional — without it `df` wraps a long device
 * name onto its own line and an obvious parser reads the *previous* filesystem's columns — and
 * `-k` pins the block size, because `df` honours `BLOCKSIZE` and `DF_BLOCK_SIZE` from the
 * environment and a login shell may well set them. See `support/ssh/parse.ts`.
 */
export const sshDiskFree: SensorType = {
  id: 'ssh.diskfree',
  category: 'SSH',
  costHint: 'medium',
  credentialKinds: ['ssh'],
  pinnedKinds: ['ssh'],
  // Where the set goes besides the host (`A-41`): the port.
  secretDestinations: { 'kind:ssh': ['port'] },

  paramsSchema: sshParamsSchema(
    {
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 1_024,
        default: '/',
        title: 'Path',
        description:
          'Any path on the filesystem to watch — “/”, “/var”, “/srv/data”. `df` reports the ' +
          'filesystem the path is on, so it need not be the mount point itself.',
      },
    },
    [],
  ),

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      { key: 'percentUsed', name: 'Disk used', unit: '%', isPrimary: true },
      { key: 'free', name: 'Free space', unit: 'B' },
      { key: 'used', name: 'Used space', unit: 'B' },
      { key: 'total', name: 'Total space', unit: 'B' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const scrub = scrubberOf(context);
    const { sshCheck, hostKeyNote, parseDf, clip } = await import('../support/ssh/index.js');
    const { percentOf, humanBytes } = await import('../support/snmp/mibs.js');

    const asked = context.params['path'];
    const path = typeof asked === 'string' && asked.trim() !== '' ? asked.trim() : '/';
    // Quoted so a path with a space is one argument. Single quotes with the shell's own escape
    // for an embedded quote, which is the only form that is safe for every path.
    const quoted = `'${path.replace(/'/g, `'\\''`)}'`;

    return sshCheck(context, async (session, signal) => {
      const result = await session.exec(`df -P -k ${quoted}`, signal);
      if (result.code !== 0) {
        throw new Error(
          `df could not read ${path} on ${context.target.host}: ` +
            clip(scrub(result.stderr.trim() === '' ? result.stdout : result.stderr)),
        );
      }

      const [row] = parseDf(result.stdout);
      if (row === undefined) {
        throw new Error(
          `df reported nothing for ${path} on ${context.target.host} — its output was ` +
            `"${clip(scrub(result.stdout))}"`,
        );
      }

      const percentUsed = percentOf(row.usedBytes, row.totalBytes);
      return {
        channels: [
          ...(percentUsed === null ? [] : [{ key: 'percentUsed', value: percentUsed }]),
          { key: 'free', value: row.freeBytes },
          { key: 'used', value: row.usedBytes },
          { key: 'total', value: row.totalBytes },
        ],
        message: [
          `${humanBytes(row.freeBytes)} free of ${humanBytes(row.totalBytes)} ` +
            `(${String(percentUsed ?? 0)}% used) on ${row.filesystem} at ${row.mountedOn}`,
          hostKeyNote(session, context.target.host),
        ]
          .filter((part): part is string => part !== null)
          .join('; '),
      };
    });
  },
};
