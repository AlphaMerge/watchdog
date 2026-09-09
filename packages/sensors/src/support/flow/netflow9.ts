import { FlowDecodeError } from './netflow5.js';
import {
  VARIABLE_LENGTH,
  type Template,
  type TemplateCache,
  type TemplateField,
} from './templates.js';

/**
 * NetFlow v9 and IPFIX (`B-03`).
 *
 * **One module for two formats because they are one format with different constants**, and
 * separating them would mean two copies of the set walk, the template parse and the record split
 * — the three places a mistake is silent rather than loud. What actually differs is enumerated in
 * `DIALECTS` below, and every difference there is one somebody has got wrong in a shipped
 * collector:
 *
 * - **The header is 20 bytes in v9 and 16 in IPFIX.** v9 carries `sysUptime` and IPFIX does not,
 *   because IPFIX gave up on the uptime clock and stamps flows in absolute time.
 * - **v9's `count` is records; IPFIX's `length` is bytes.** Reading one as the other walks off
 *   the end of a short message or stops early on a long one.
 * - **Template sets are 0 and 1 in v9, 2 and 3 in IPFIX.** A v9 collector reading IPFIX treats
 *   template set 2 as a *data* set for template 2, which does not exist, and reports every
 *   template as an undecodable record.
 * - **IPFIX has enterprise-specific elements and variable-length fields; v9 has neither.** The
 *   top bit of the element id is the enterprise flag and a further four bytes follow it; a length
 *   of 65535 means the record carries its own.
 * - **The sequence number counts different things** — v9 counts *packets*, IPFIX counts *data
 *   records* — which is why `sequenceCounts` exists and why `B-02`'s loss arithmetic cannot be
 *   applied to both the same way.
 *
 * **A record that cannot be decoded is counted, never guessed at.** The template may not have
 * arrived yet — which happens on every collector restart and every exporter reboot, since data
 * flows continuously and templates come round on the exporter's own schedule. Decoding it anyway,
 * against a stale template or a guessed layout, produces confident wrong numbers; and a wrong
 * number in a monitoring system is worse than a missing one, because nothing downstream can tell.
 */

export const NETFLOW_V9 = 9;
export const IPFIX = 10;

interface Dialect {
  readonly version: number;
  readonly headerBytes: number;
  readonly templateSetId: number;
  readonly optionsSetId: number;
  /** IPFIX only: enterprise bit and variable-length encoding in template fields. */
  readonly enterpriseFields: boolean;
  /** What the header's sequence number counts, which is not the same thing in the two formats. */
  readonly sequenceCounts: 'packets' | 'data-records';
}

const DIALECTS: Readonly<Record<number, Dialect>> = {
  [NETFLOW_V9]: {
    version: NETFLOW_V9,
    headerBytes: 20,
    templateSetId: 0,
    optionsSetId: 1,
    enterpriseFields: false,
    sequenceCounts: 'packets',
  },
  [IPFIX]: {
    version: IPFIX,
    headerBytes: 16,
    templateSetId: 2,
    optionsSetId: 3,
    enterpriseFields: true,
    sequenceCounts: 'data-records',
  },
};

/** Set ids below this are structural; at or above it, the id *is* a template id. */
const FIRST_DATA_SET_ID = 256;

/** A set header is an id and a length, both 16-bit. */
const SET_HEADER_BYTES = 4;

export interface FlowSetHeader {
  readonly version: number;
  /** Milliseconds since the exporter booted. Absent in IPFIX, which has no uptime clock. */
  readonly sysUptimeMs?: number;
  /** The exporter's wall clock when it sent this, in seconds. */
  readonly unixSecs: number;
  readonly sequence: number;
  readonly sequenceCounts: 'packets' | 'data-records';
  /** `sourceId` in v9, `observationDomainId` in IPFIX. The same thing under two names. */
  readonly observationDomain: number;
}

/** One decoded data record: element id to raw bytes, left for `B-04` to interpret. */
export type FlowFields = ReadonlyMap<number, Buffer>;

export interface DecodedFlowSets {
  readonly header: FlowSetHeader;
  readonly records: readonly FlowFields[];
  /** Templates learnt from this message, for a caller that wants to log or count them. */
  readonly templatesLearnt: number;
  /**
   * Data records whose template this collector has not got.
   *
   * **Not an error and not zero-by-default.** It is the ordinary state for a few seconds after a
   * restart, and a number an operator should be able to watch fall to zero. It stays above zero
   * when an exporter's template refresh interval is longer than its data interval, which is a
   * configuration fault on the device and invisible without this count.
   */
  readonly undecodable: number;
}

export function isTemplatedVersion(version: number): boolean {
  return version === NETFLOW_V9 || version === IPFIX;
}

/**
 * Decodes one v9 or IPFIX message, learning templates into `cache` and decoding what it can.
 *
 * Templates are learnt **as they are met, in order**, so a message carrying a template and then
 * data for that same template decodes fully — which is exactly what an exporter sends in its
 * first datagram after a restart, and a collector that made two passes would drop.
 */
export function decodeFlowSets(
  datagram: Buffer,
  exporter: string,
  cache: TemplateCache,
): DecodedFlowSets {
  if (datagram.length < 2) {
    throw new FlowDecodeError(
      { kind: 'too-short', got: datagram.length, need: 2 },
      `a flow datagram of ${String(datagram.length)} bytes cannot hold a version`,
    );
  }

  const version = datagram.readUInt16BE(0);
  const dialect = DIALECTS[version];
  if (dialect === undefined) {
    throw new FlowDecodeError(
      { kind: 'unsupported-version', version },
      `NetFlow version ${String(version)} is neither 9 nor 10 (IPFIX)`,
    );
  }

  if (datagram.length < dialect.headerBytes) {
    throw new FlowDecodeError(
      { kind: 'too-short', got: datagram.length, need: dialect.headerBytes },
      `a v${String(version)} datagram of ${String(datagram.length)} bytes cannot hold its ${String(dialect.headerBytes)}-byte header`,
    );
  }

  // The two headers agree on nothing but the version, so they are read apart rather than through
  // a shared offset table that would have to be right about both.
  const header: FlowSetHeader =
    version === NETFLOW_V9
      ? {
          version,
          sysUptimeMs: datagram.readUInt32BE(4),
          unixSecs: datagram.readUInt32BE(8),
          sequence: datagram.readUInt32BE(12),
          sequenceCounts: dialect.sequenceCounts,
          observationDomain: datagram.readUInt32BE(16),
        }
      : {
          version,
          unixSecs: datagram.readUInt32BE(4),
          sequence: datagram.readUInt32BE(8),
          sequenceCounts: dialect.sequenceCounts,
          observationDomain: datagram.readUInt32BE(12),
        };

  // **IPFIX states its own total length and v9 does not.** Honouring it matters because a UDP
  // datagram may carry padding past the message, and walking that as sets invents garbage ones.
  const end =
    version === IPFIX ? Math.min(datagram.readUInt16BE(2), datagram.length) : datagram.length;
  if (version === IPFIX && end < dialect.headerBytes) {
    throw new FlowDecodeError(
      { kind: 'truncated', claimed: datagram.readUInt16BE(2), present: datagram.length },
      `an IPFIX message declares ${String(datagram.readUInt16BE(2))} bytes, shorter than its own header`,
    );
  }

  const records: FlowFields[] = [];
  let templatesLearnt = 0;
  let undecodable = 0;
  let at = dialect.headerBytes;

  while (at + SET_HEADER_BYTES <= end) {
    const setId = datagram.readUInt16BE(at);
    const setLength = datagram.readUInt16BE(at + 2);

    // **A set shorter than its own header, or longer than what is left, ends the walk.** Without
    // this a zero length is an infinite loop and an overlong one reads adjacent memory as fields.
    if (setLength < SET_HEADER_BYTES || at + setLength > end) {
      throw new FlowDecodeError(
        { kind: 'truncated', claimed: setLength, present: end - at },
        `a set declares ${String(setLength)} bytes with ${String(end - at)} left in the message`,
      );
    }

    const body = datagram.subarray(at + SET_HEADER_BYTES, at + setLength);

    if (setId === dialect.templateSetId || setId === dialect.optionsSetId) {
      const kind = setId === dialect.optionsSetId ? 'options' : 'data';
      templatesLearnt += learnTemplates(
        body,
        exporter,
        header.observationDomain,
        cache,
        dialect,
        kind,
      );
    } else if (setId >= FIRST_DATA_SET_ID) {
      const template = cache.get({
        exporter,
        observationDomain: header.observationDomain,
        templateId: setId,
      });
      if (template === undefined) {
        // Counted, not guessed at. See the note on this module.
        undecodable += 1;
      } else {
        for (const record of splitRecords(body, template)) records.push(record);
      }
    }
    // Set ids 1..255 that are not this dialect's template ids are reserved. Skipped in silence
    // rather than refused: the specifications reserve them for future use, and a collector that
    // rejected a whole datagram over one would fail against a future exporter for no reason.

    at += setLength;
  }

  return { header, records, templatesLearnt, undecodable };
}

/** Template sets hold a run of template records, each naming its id and its fields. */
function learnTemplates(
  body: Buffer,
  exporter: string,
  observationDomain: number,
  cache: TemplateCache,
  dialect: Dialect,
  kind: 'data' | 'options',
): number {
  let at = 0;
  let learnt = 0;

  while (at + 4 <= body.length) {
    const templateId = body.readUInt16BE(at);
    const fieldCount = body.readUInt16BE(at + 2);
    at += 4;

    // A template id below 256 is not a template id; that range is the set ids themselves. A
    // count of zero is a withdrawal in IPFIX and meaningless in v9 — either way there is nothing
    // to learn, and continuing to read fields would consume the next template's header.
    if (templateId < FIRST_DATA_SET_ID || fieldCount === 0) break;

    const fields: TemplateField[] = [];
    for (let i = 0; i < fieldCount; i += 1) {
      if (at + 4 > body.length) return learnt; // Padding, or a template cut short by the MTU.
      let id = body.readUInt16BE(at);
      const length = body.readUInt16BE(at + 2);
      at += 4;

      let enterprise: number | undefined;
      // IPFIX §3.2: the top bit of the element id says a four-byte enterprise number follows.
      if (dialect.enterpriseFields && (id & 0x8000) !== 0) {
        if (at + 4 > body.length) return learnt;
        id &= 0x7fff;
        enterprise = body.readUInt32BE(at);
        at += 4;
      }

      fields.push(enterprise === undefined ? { id, length } : { id, length, enterprise });
    }

    cache.learn({ exporter, observationDomain, templateId }, fields, kind);
    learnt += 1;
  }

  return learnt;
}

/**
 * Splits a data set into records using its template.
 *
 * **The trailing bytes are padding, not a short record.** A set is padded to a 4-byte boundary,
 * so a remainder smaller than one record is expected and must be ignored rather than decoded —
 * reading it produces a record of zeroes that looks exactly like a real flow carrying none.
 */
function* splitRecords(body: Buffer, template: Template): Generator<FlowFields> {
  if (template.recordBytes !== undefined) {
    for (let at = 0; at + template.recordBytes <= body.length; at += template.recordBytes) {
      const fields = new Map<number, Buffer>();
      let cursor = at;
      for (const field of template.fields) {
        fields.set(field.id, body.subarray(cursor, cursor + field.length));
        cursor += field.length;
      }
      yield fields;
    }
    return;
  }

  // Variable-length records (IPFIX only) have to be walked field by field, because where the next
  // record starts is not knowable until this one has been read to its end.
  let at = 0;
  while (at < body.length) {
    const fields = new Map<number, Buffer>();
    let cursor = at;
    let complete = true;

    for (const field of template.fields) {
      let length = field.length;
      if (length === VARIABLE_LENGTH) {
        if (cursor >= body.length) {
          complete = false;
          break;
        }
        // IPFIX §7: one length byte, or 255 followed by a two-byte length.
        length = body.readUInt8(cursor);
        cursor += 1;
        if (length === 255) {
          if (cursor + 2 > body.length) {
            complete = false;
            break;
          }
          length = body.readUInt16BE(cursor);
          cursor += 2;
        }
      }
      if (cursor + length > body.length) {
        complete = false;
        break;
      }
      fields.set(field.id, body.subarray(cursor, cursor + length));
      cursor += length;
    }

    if (!complete) return;
    yield fields;
    if (cursor === at) return; // A template of nothing but zero-length fields would not advance.
    at = cursor;
  }
}
