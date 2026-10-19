import type { Logger } from '@ms/shared';
import { HelperTroubleLatch } from '../health/latch.js';
import { AnswerFile, answerFilePath, type AnswerFileOptions } from './answer-file.js';
import { LookupHelper, type LookupHelperOptions } from './lookup-helper.js';
import { NameResolver, type NameResolverOptions } from './name-resolver.js';
import { GlibcNamePolicy, type GlibcNamePolicyOptions } from './system-names.js';

/**
 * The probe's name resolution as `probe.nameResolver` sets it (`P-432` §1.2): the resolver, its
 * answer file and, in gate mode only, the name policy, the lookup helper and the helper's trouble
 * latch. **In `system` mode none of the gate is built**: no policy reads a file, no child is forked
 * and no socket is opened, so `system` is `P-426` with `P-438`, exactly.
 *
 * `start` runs in `main.ts`'s order, before the check pool: the answer file loads; in gate mode
 * the resolver's first look at its watched files loads the policy from the same reading, the
 * policy's description is logged, and the helper starts on the policy's snapshot (it resolves
 * within `HELPER_START_WAIT_MS`, up or not, and never rejects); then the watch and the answer
 * file's timer start. `stop` stops the resolver, then the helper and the answer file together.
 */

export type NameResolverMode = 'system' | 'gate';

/** The `nameResolverMode` Probe Health sends (D29): 1 `system`; 2 `gate`; 3 `gate`, resting. */
export type NameResolverModeValue = 1 | 2 | 3;

export interface NameResolutionOptions {
  readonly mode: NameResolverMode;
  readonly logger: Logger;
  readonly lanes: number;
  readonly spoolDir: string;
  /** The probe's lifecycle signal: once aborted, the helper starts no new child. */
  readonly signal?: AbortSignal;
  /** For tests: what each part is built with besides. */
  readonly resolver?: Partial<NameResolverOptions>;
  readonly answerFile?: Partial<Omit<AnswerFileOptions, 'resolver' | 'logger'>>;
  readonly helper?: Partial<Omit<LookupHelperOptions, 'logger' | 'onChange' | 'onLateAnswer'>>;
  readonly policy?: Partial<Omit<GlibcNamePolicyOptions, 'logger'>>;
  /** The latch's clock: `performance.now` unless a test says. */
  readonly now?: () => number;
}

/** Gate mode's parts, built only in gate mode. */
export interface GateResolution {
  readonly helper: LookupHelper;
  readonly policy: GlibcNamePolicy;
  readonly latch: HelperTroubleLatch;
}

export interface NameResolution {
  readonly mode: NameResolverMode;
  readonly resolver: NameResolver;
  readonly answerFile: AnswerFile;
  readonly gate: GateResolution | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Probe Health's `nameResolverMode`, in both modes. */
  modeValue(): NameResolverModeValue;
}

export function buildNameResolution(options: NameResolutionOptions): NameResolution {
  const { logger, mode } = options;
  const now = options.now ?? (() => performance.now());
  let gate: GateResolution | undefined;
  // Late-bound: the helper reports to the resolver, which is built with the helper.
  const late: { resolver?: NameResolver } = {};
  if (mode === 'gate') {
    const latch = new HelperTroubleLatch({ logger, now });
    const policy = new GlibcNamePolicy({ ...options.policy, logger });
    const helper = new LookupHelper({
      ...options.helper,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      logger,
      onChange: (change) => {
        latch.change(change);
        late.resolver?.onHelperChange(change);
      },
      onLateAnswer: (ref, outcome) => {
        late.resolver?.onHelperLateAnswer(ref, outcome);
      },
    });
    gate = { helper, policy, latch };
  }
  const built = new NameResolver({
    logger,
    lanes: options.lanes,
    ...options.resolver,
    ...(gate === undefined ? {} : { gate: { helper: gate.helper, policy: gate.policy } }),
  });
  late.resolver = built;
  const answerFile = new AnswerFile({
    path: answerFilePath(options.spoolDir),
    ...options.answerFile,
    resolver: built,
    logger,
  });
  const parts = gate;
  return {
    mode,
    resolver: built,
    answerFile,
    gate: parts,
    async start() {
      await answerFile.load();
      if (parts !== undefined) {
        await built.firstLook();
        logger.info(
          { nameResolver: 'gate', ...parts.policy.describe() },
          'probe.nameResolver is gate: the name policy the probe routes its lookups by',
        );
        await parts.helper.start(parts.policy.snapshot());
      }
      built.start();
      answerFile.start();
    },
    async stop() {
      built.stop();
      await Promise.all([parts?.helper.stop(), answerFile.stop()]);
    },
    modeValue() {
      if (parts === undefined) return 1;
      return parts.helper.routeState() === 'resting' ? 3 : 2;
    },
  };
}
