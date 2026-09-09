import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderIpfix, renderNetflowV9, variableLength } from '@ms/simulators';
import {
  FlowDecodeError,
  TemplateCache,
  VARIABLE_LENGTH,
  decodeFlowSets,
} from '../src/support/flow/index.js';

/**
 * NetFlow v9 and IPFIX (`B-03`).
 *
 * The messages come from `@ms/simulators`, which writes them against RFC 3954 and RFC 7011 rather
 * than by running this decoder backwards. Both dialects are exercised at every point they differ,
 * because those differences are where a collector that "supports IPFIX" turns out to support v9
 * with a different number in the header.
 */

const EXPORTER = '192.0.2.1';

/** srcIPv4 (8) and dstIPv4 (12), four bytes each — the smallest useful template. */
const ADDRESSES = [
  { id: 8, length: 4 },
  { id: 12, length: 4 },
];

function record(src: string, dst: string): Buffer {
  return Buffer.concat([
    Buffer.from(src.split('.').map(Number)),
    Buffer.from(dst.split('.').map(Number)),
  ]);
}

describe('NetFlow v9 and IPFIX', () => {
  for (const [name, render] of [
    ['v9', renderNetflowV9],
    ['IPFIX', renderIpfix],
  ] as const) {
    describe(name, () => {
      it('learns a template and decodes data carried in the same message', () => {
        // **What an exporter sends in its first datagram after a restart.** A collector that made
        // two passes, or learnt templates only after walking the sets, would drop this.
        const cache = new TemplateCache();
        const message = render(
          [{ templateId: 256, fields: ADDRESSES }],
          [{ templateId: 256, records: [record('10.0.0.1', '10.0.0.2')] }],
        );

        const decoded = decodeFlowSets(message, EXPORTER, cache);
        assert.equal(decoded.templatesLearnt, 1);
        assert.equal(decoded.undecodable, 0);
        assert.equal(decoded.records.length, 1);
        assert.deepEqual([...(decoded.records[0]?.get(8) ?? [])], [10, 0, 0, 1]);
        assert.deepEqual([...(decoded.records[0]?.get(12) ?? [])], [10, 0, 0, 2]);
      });

      it('counts a data record whose template has not arrived, rather than guessing', () => {
        // The ordinary state for a few seconds after a collector restart — and permanent when an
        // exporter's template refresh interval is longer than its data interval, which is a
        // device misconfiguration invisible without this count.
        const cache = new TemplateCache();
        const decoded = decodeFlowSets(
          render([], [{ templateId: 256, records: [record('10.0.0.1', '10.0.0.2')] }]),
          EXPORTER,
          cache,
        );
        assert.equal(decoded.records.length, 0);
        assert.equal(decoded.undecodable, 1);
      });

      it('decodes later messages once the template is cached', () => {
        const cache = new TemplateCache();
        decodeFlowSets(render([{ templateId: 256, fields: ADDRESSES }], []), EXPORTER, cache);
        const decoded = decodeFlowSets(
          render([], [{ templateId: 256, records: [record('10.0.0.9', '10.0.0.8')] }]),
          EXPORTER,
          cache,
        );
        assert.equal(decoded.records.length, 1);
        assert.equal(decoded.undecodable, 0);
      });

      it('splits several records out of one data set', () => {
        const cache = new TemplateCache();
        const decoded = decodeFlowSets(
          render(
            [{ templateId: 256, fields: ADDRESSES }],
            [
              {
                templateId: 256,
                records: [
                  record('10.0.0.1', '10.0.0.2'),
                  record('10.0.0.3', '10.0.0.4'),
                  record('10.0.0.5', '10.0.0.6'),
                ],
              },
            ],
          ),
          EXPORTER,
          cache,
        );
        assert.equal(decoded.records.length, 3);
      });

      it('ignores padding too short to be a record', () => {
        // Sets are padded to a 4-byte boundary. Decoding the remainder produces a record of
        // zeroes indistinguishable from a real flow carrying none.
        const cache = new TemplateCache();
        const decoded = decodeFlowSets(
          render(
            [{ templateId: 256, fields: ADDRESSES }],
            [
              {
                templateId: 256,
                records: [record('10.0.0.1', '10.0.0.2'), Buffer.alloc(3)],
              },
            ],
          ),
          EXPORTER,
          cache,
        );
        assert.equal(decoded.records.length, 1);
      });

      it('keeps one exporter’s templates away from another’s data', () => {
        const cache = new TemplateCache();
        decodeFlowSets(render([{ templateId: 256, fields: ADDRESSES }], []), EXPORTER, cache);
        const decoded = decodeFlowSets(
          render([], [{ templateId: 256, records: [record('10.0.0.1', '10.0.0.2')] }]),
          '198.51.100.9',
          cache,
        );
        assert.equal(decoded.undecodable, 1, 'a different exporter, so a different template 256');
      });

      it('keeps one observation domain’s templates away from another’s data', () => {
        const cache = new TemplateCache();
        decodeFlowSets(
          render([{ templateId: 256, fields: ADDRESSES }], [], { observationDomain: 1 }),
          EXPORTER,
          cache,
        );
        const decoded = decodeFlowSets(
          render([], [{ templateId: 256, records: [record('10.0.0.1', '10.0.0.2')] }], {
            observationDomain: 2,
          }),
          EXPORTER,
          cache,
        );
        assert.equal(decoded.undecodable, 1);
      });

      it('reads the header the format actually specifies', () => {
        const cache = new TemplateCache();
        const { header } = decodeFlowSets(
          render([{ templateId: 256, fields: ADDRESSES }], [], {
            unixSecs: 1_700_000_000,
            sequence: 42,
            observationDomain: 7,
          }),
          EXPORTER,
          cache,
        );
        assert.equal(header.unixSecs, 1_700_000_000);
        assert.equal(header.sequence, 42);
        assert.equal(header.observationDomain, 7);
      });

      it('refuses a set that claims more bytes than the message holds', () => {
        // Without this an overlong length reads adjacent memory as fields, and a zero-length set
        // is an infinite loop.
        const cache = new TemplateCache();
        const message = render(
          [{ templateId: 256, fields: ADDRESSES }],
          [{ templateId: 256, records: [record('10.0.0.1', '10.0.0.2')] }],
        );
        // Find the data set header and inflate its length.
        const at = message.length - 12;
        assert.equal(message.readUInt16BE(at), 256, 'located the data set header');
        message.writeUInt16BE(4_000, at + 2);

        assert.throws(
          () => decodeFlowSets(message, EXPORTER, cache),
          (error: unknown) => {
            assert.ok(error instanceof FlowDecodeError);
            assert.equal(error.reason.kind, 'truncated');
            return true;
          },
        );
      });
    });
  }

  describe('where the two formats differ', () => {
    it('reads the header at the right width for each — 20 bytes in v9, 16 in IPFIX', () => {
      // A 20-byte read of an IPFIX header takes the first set's id and length as part of the
      // header, and every set after it is misaligned.
      const cache = new TemplateCache();
      const v9 = decodeFlowSets(
        renderNetflowV9([{ templateId: 256, fields: ADDRESSES }], [], { sysUptimeMs: 12_345 }),
        EXPORTER,
        cache,
      );
      const ipfix = decodeFlowSets(
        renderIpfix([{ templateId: 300, fields: ADDRESSES }], []),
        EXPORTER,
        cache,
      );
      assert.equal(v9.templatesLearnt, 1);
      assert.equal(ipfix.templatesLearnt, 1);
      assert.equal(v9.header.sysUptimeMs, 12_345, 'v9 has an uptime clock');
      assert.equal(ipfix.header.sysUptimeMs, undefined, 'IPFIX does not');
    });

    it('says what the sequence number counts, because it is not the same thing', () => {
      // v9 counts exported *packets*, IPFIX counts *data records*. Applying one meaning to the
      // other turns a healthy exporter into one apparently losing thousands of flows.
      const cache = new TemplateCache();
      const v9 = decodeFlowSets(renderNetflowV9([], []), EXPORTER, cache);
      const ipfix = decodeFlowSets(renderIpfix([], []), EXPORTER, cache);
      assert.equal(v9.header.sequenceCounts, 'packets');
      assert.equal(ipfix.header.sequenceCounts, 'data-records');
    });

    it('takes template sets from 0/1 in v9 and 2/3 in IPFIX', () => {
      // A v9 collector reading IPFIX treats set 2 as data for template 2 — which does not exist,
      // so every template arrives as an undecodable record and nothing ever decodes.
      const cache = new TemplateCache();
      assert.equal(
        decodeFlowSets(
          renderNetflowV9([{ templateId: 256, fields: ADDRESSES }], []),
          EXPORTER,
          cache,
        ).templatesLearnt,
        1,
      );
      assert.equal(
        decodeFlowSets(renderIpfix([{ templateId: 256, fields: ADDRESSES }], []), EXPORTER, cache)
          .templatesLearnt,
        1,
      );
    });

    it('learns an options template into the same cache, marked as one', () => {
      const cache = new TemplateCache();
      decodeFlowSets(
        renderIpfix([{ templateId: 400, fields: ADDRESSES, options: true }], []),
        EXPORTER,
        cache,
      );
      assert.equal(
        cache.get({ exporter: EXPORTER, observationDomain: 0, templateId: 400 })?.kind,
        'options',
      );
    });

    it('honours IPFIX’s declared length and ignores what follows it', () => {
      // A UDP datagram may carry padding past the message. Walking it as sets invents garbage.
      const cache = new TemplateCache();
      const decoded = decodeFlowSets(
        renderIpfix([{ templateId: 256, fields: ADDRESSES }], [], {
          trailing: Buffer.alloc(16, 0xff),
        }),
        EXPORTER,
        cache,
      );
      assert.equal(decoded.templatesLearnt, 1, 'and no garbage set from the padding');
    });

    it('reads an IPFIX enterprise field, which v9 has no concept of', () => {
      // The top bit of the element id says a four-byte enterprise number follows. A decoder that
      // missed it reads the enterprise number as the next field's id and length.
      const cache = new TemplateCache();
      decodeFlowSets(
        renderIpfix(
          [{ templateId: 256, fields: [{ id: 1, length: 4, enterprise: 9 }, ...ADDRESSES] }],
          [],
        ),
        EXPORTER,
        cache,
      );
      const template = cache.get({ exporter: EXPORTER, observationDomain: 0, templateId: 256 });
      assert.ok(template, 'the template was learnt');
      assert.equal(template.fields.length, 3);
      const [enterpriseField, nextField] = template.fields;
      assert.ok(enterpriseField && nextField);
      assert.equal(enterpriseField.enterprise, 9);
      assert.equal(enterpriseField.id, 1, 'with the enterprise bit stripped from the id');
      assert.equal(nextField.id, 8, 'and the next field read at the right offset');
    });

    it('reads IPFIX variable-length fields, and finds the next record after one', () => {
      const cache = new TemplateCache();
      const decoded = decodeFlowSets(
        renderIpfix(
          [
            {
              templateId: 256,
              fields: [
                { id: 8, length: 4 },
                { id: 82, length: VARIABLE_LENGTH },
              ],
            },
          ],
          [
            {
              templateId: 256,
              records: [
                Buffer.concat([
                  record('10.0.0.1', '0.0.0.0').subarray(0, 4),
                  variableLength('eth0'),
                ]),
                Buffer.concat([
                  record('10.0.0.2', '0.0.0.0').subarray(0, 4),
                  variableLength('GigabitEthernet0/1'),
                ]),
              ],
            },
          ],
        ),
        EXPORTER,
        cache,
      );

      assert.equal(decoded.records.length, 2);
      const [first, second] = decoded.records;
      assert.ok(first && second);
      assert.equal(first.get(82)?.toString('utf8'), 'eth0');
      assert.equal(second.get(82)?.toString('utf8'), 'GigabitEthernet0/1');
      assert.deepEqual([...(second.get(8) ?? [])], [10, 0, 0, 2]);
    });
  });

  it('refuses a version that is neither', () => {
    const cache = new TemplateCache();
    const message = renderNetflowV9([], []);
    message.writeUInt16BE(7, 0);
    assert.throws(
      () => decodeFlowSets(message, EXPORTER, cache),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'unsupported-version');
        return true;
      },
    );
  });
});
