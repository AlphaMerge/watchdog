import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { within } from '../support/within.js';

/**
 * A capturing process for the differential's replay (`P-432` S8): `tcpdump` on `lo`, for the
 * questions glibc sends systemd-resolved's stub. Every wait on it has its own bound, shorter than
 * the replay's, and **its exit is listened for from the moment it starts**: a capture that ends on
 * its own, before it is told to stop, is heard to have ended, and `stop` says so at once rather
 * than waiting for an exit that has already happened.
 */
export interface CaptureOptions {
  readonly command: string;
  readonly argv: readonly string[];
  /** What the process writes on stderr once it is capturing. */
  readonly ready: string;
  readonly startBoundMs: number;
  readonly stopBoundMs: number;
  /** Time given after it is ready, and before it is stopped, for packets to be written. */
  readonly settleMs: number;
}

export interface Capture {
  /** Stops the capture with SIGINT. Rejects if it had already ended, or does not end in time. */
  stop(): Promise<void>;
}

export async function startCapture(options: CaptureOptions): Promise<Capture> {
  const child = spawn(options.command, [...options.argv], { stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  const ended = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', (error) => {
      said += String(error);
      resolve();
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stderr.on('data', (chunk: Buffer) => {
      said += chunk.toString();
      if (said.includes(options.ready)) resolve();
    });
    void exited.then(() => {
      reject(new Error(`${options.command} exited before it was ready: ${said}`));
    });
  });
  try {
    await within(options.startBoundMs, () => `${options.command} to be ready: ${said}`, ready);
  } catch (error: unknown) {
    child.kill('SIGKILL');
    throw error;
  }
  await sleep(options.settleMs);
  return {
    async stop(): Promise<void> {
      await sleep(options.settleMs);
      if (ended()) {
        throw new Error(`${options.command} ended before it was stopped: ${said}`);
      }
      child.kill('SIGINT');
      try {
        await within(options.stopBoundMs, `${options.command} to stop`, exited);
      } catch (error: unknown) {
        child.kill('SIGKILL');
        throw error;
      }
    },
  };
}
