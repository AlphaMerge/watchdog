import { strict as assert } from 'node:assert';
import { XMLValidator } from 'fast-xml-parser';

/**
 * Well-formedness, checked by something that is not us (`E-07`).
 *
 * A renderer checked only against the regexes that wrote it can be well-formed by accident and
 * unparseable in fact. The document a script actually receives is the one a parser produces, so
 * that is what the report tests assert against — and the failure this guards is total: an XML
 * 1.0 document with one illegal byte in it is refused whole, so a scheduled report that produced
 * one would leave an empty folder and nothing that had failed.
 *
 * **`XMLValidator` is deprecated in favour of the separate `fast-xml-validator` package**, and it
 * is used anyway: the successor brings three more packages with it, and this is a test-only
 * well-formedness check against a parser that is already in the tree. The suppression is here, in
 * one place, rather than at each of the call sites.
 */
export function assertWellFormed(xml: string): void {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the note above on the successor.
  const verdict = XMLValidator.validate(xml);
  assert.equal(verdict, true, `the document does not parse: ${JSON.stringify(verdict)}`);
}
