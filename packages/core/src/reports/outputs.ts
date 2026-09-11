import { ReportError } from './errors.js';

/**
 * What a report produces and where it goes (`E-09`, `CAPABILITIES.MD §6`).
 *
 * `§6` offers HTML, PDF, CSV and XML, and three delivery modes. **Two of those four formats are
 * not here.** PDF is `E-05`, gated on Phase 13's first decision and on nothing in this ticket;
 * XML is a format nobody has asked for that would be a third rendering of the same document,
 * and admitting it now would mean maintaining a schema for it before anybody has said what shape
 * they want. `ADR-005` Decision 3 records which formats a stored report may hold and why the list
 * is reopened when a PDF exists.
 */

export const REPORT_FORMATS = ['html', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_DELIVERY_MODES = ['store', 'store-and-email', 'email'] as const;
export type ReportDeliveryMode = (typeof REPORT_DELIVERY_MODES)[number];

export interface ReportOutputs {
  /** At least one. A report that renders nothing is a scheduled no-op. */
  readonly formats: readonly ReportFormat[];
  readonly delivery: ReportDeliveryMode;
  /**
   * Where an emailed report goes.
   *
   * **Addresses, not accounts.** `N-07`'s templates can address a user or a group and resolve them
   * at send time; a report is sent to whoever is supposed to read it, which is routinely a
   * distribution list or somebody outside the installation. Resolving accounts here would be a
   * second, quieter way for a report's audience to differ from the people it renders as — and
   * `E-03` is careful that those are two separate decisions.
   */
  readonly recipients: readonly string[];
  /** One archive rather than several attachments. */
  readonly zip: boolean;
}

/** How many addresses one report may go to. A report is not a mailing list. */
export const MAX_RECIPIENTS = 50;

const MAX_ADDRESS = 320;

export const DEFAULT_OUTPUTS: ReportOutputs = {
  formats: ['html'],
  // Store, not email: creating a report must not arrange for this system to send mail, which is
  // the same reason `E-08`'s schedule defaults to manual.
  delivery: 'store',
  recipients: [],
  zip: false,
};

/** Whether this mode keeps the document once it has been dealt with (`ADR-005` Decision 4). */
export function keepsOutput(mode: ReportDeliveryMode): boolean {
  return mode !== 'email';
}

export function sendsEmail(mode: ReportDeliveryMode): boolean {
  return mode !== 'store';
}

function invalid(message: string, details: Record<string, unknown> = {}): ReportError {
  return new ReportError('REPORT_INVALID', message, { context: { phase: 'outputs' }, details });
}

/**
 * Checks an outputs document and returns it narrowed, or throws.
 *
 * On the write, like the span, the schedule and the security context. **The one that matters most
 * here is the recipient list**: a report set to email with nowhere to send it would render every
 * month, fail delivery, and be discovered by somebody asking where the report is.
 */
export function validateOutputs(raw: unknown): ReportOutputs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('a report output is an object naming formats and a delivery mode');
  }
  const input = raw as Record<string, unknown>;

  const formats = input['formats'] ?? ['html'];
  if (!Array.isArray(formats) || formats.length === 0) {
    throw invalid('a report renders at least one format');
  }
  const seen: ReportFormat[] = [];
  for (const format of formats as readonly unknown[]) {
    if (typeof format !== 'string' || !(REPORT_FORMATS as readonly string[]).includes(format)) {
      throw invalid(`there is no report format called ${JSON.stringify(format)}`, { format });
    }
    // Deduplicated rather than refused: asking for HTML twice is a clumsy edit, not an error, and
    // rendering it twice would put two identical attachments on the same email.
    if (!seen.includes(format as ReportFormat)) seen.push(format as ReportFormat);
  }

  const delivery = input['delivery'] ?? 'store';
  if (
    typeof delivery !== 'string' ||
    !(REPORT_DELIVERY_MODES as readonly string[]).includes(delivery)
  ) {
    throw invalid(`there is no delivery mode called ${JSON.stringify(delivery)}`, { delivery });
  }
  const mode = delivery as ReportDeliveryMode;

  const zip = input['zip'] ?? false;
  if (typeof zip !== 'boolean') throw invalid('zip is on or off');

  const recipients = readRecipients(input['recipients'], mode);
  return { formats: seen, delivery: mode, recipients, zip };
}

function readRecipients(raw: unknown, mode: ReportDeliveryMode): readonly string[] {
  const list = raw ?? [];
  if (!Array.isArray(list)) throw invalid('recipients are a list of email addresses');

  const addresses: string[] = [];
  for (const entry of list as readonly unknown[]) {
    if (typeof entry !== 'string') throw invalid('a recipient is an email address');
    const address = entry.trim();
    // Deliberately not a full RFC 5322 grammar. That grammar admits things no relay accepts and
    // rejects things some do, and the relay is the authority either way — what this catches is
    // the typo, and what it must catch is a newline, because a header is line-oriented and an
    // address is user input (`N-07` sanitises again on the way out; this is the earlier guard).
    if (
      address.length === 0 ||
      address.length > MAX_ADDRESS ||
      !address.includes('@') ||
      /[\s,;<>]/u.test(address)
    ) {
      throw invalid(`${JSON.stringify(entry)} is not an email address this system will send to`, {
        recipient: entry,
      });
    }
    if (!addresses.includes(address)) addresses.push(address);
  }

  if (addresses.length > MAX_RECIPIENTS) {
    throw invalid(`a report goes to at most ${String(MAX_RECIPIENTS)} addresses`, {
      count: addresses.length,
    });
  }
  if (sendsEmail(mode) && addresses.length === 0) {
    // **Refused at the write rather than at 03:00.** A report set to email with nowhere to send
    // it renders every month, fails, and is found by somebody asking where the report is.
    throw invalid(`a report delivered by "${mode}" needs at least one recipient`);
  }
  if (!sendsEmail(mode) && addresses.length > 0) {
    // A recipient list on a stored-only report is a setting that looks saved and sends nothing.
    throw invalid('a stored report has no recipients; set delivery to email to use them');
  }
  return addresses;
}
