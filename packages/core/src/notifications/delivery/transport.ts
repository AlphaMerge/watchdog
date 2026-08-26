import type { Recipient } from '../templates.js';

/** A message, rendered and ready to send. */
export interface OutgoingMessage {
  /** The request this is about, for the log line and the correlation id. */
  readonly requestId: number;
  readonly sensorId: number;
  readonly subject: string;
  readonly body: string;
  readonly recipients: readonly Recipient[];
  /** 1 (highest) to 5 (lowest), from the template. */
  readonly priority: number;
  /** The method's own settings, already validated and still holding their secrets. */
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * What one attempt did.
 *
 * `retryable` is the whole of the distinction that matters: a relay that timed out will probably
 * work in five minutes, and an address the relay rejected as malformed will not work ever. Trying
 * the second one forever is how a queue fills up with something nobody will ever receive, and
 * giving up on the first is how an outage goes unreported because the network hiccuped.
 */
export type DeliveryResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

/**
 * How one delivery method sends (`N-07` onwards).
 *
 * Narrow on purpose. Everything the dispatcher does — claiming, rendering, retrying, recording —
 * is the same for every method, so a transport is handed a finished message and asked only
 * whether it went. `N-08`'s webhook, `N-09`'s Slack and Teams and `N-10`'s program each add one
 * of these and nothing else.
 */
export interface DeliveryTransport {
  /** The `NotificationMethod` id this serves. */
  readonly method: string;
  send(message: OutgoingMessage): Promise<DeliveryResult>;
  /** Releases whatever it holds open. Called at shutdown. */
  close?(): Promise<void>;
}

/**
 * Removes anything that could end a header line.
 *
 * A subject is built from a sensor's name and a probe's own message, and neither is under this
 * system's control: a check that reports `ETIMEDOUT\r\nBcc: someone@else` would otherwise be
 * writing headers. Nodemailer encodes headers properly and has still had CRLF-injection
 * advisories against three separate fields, which is the argument for doing it here as well
 * rather than instead.
 *
 * Collapsed to a space rather than dropped, so a two-line probe message still reads as two
 * clauses instead of running together into one word.
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
