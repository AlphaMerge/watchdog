import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * XML into a plain object tree (`T-24`).
 *
 * **A dependency rather than a hand-written parser, and that is the decision this ticket exists
 * to make.** `T-16` split it out for exactly this reason: namespaces, CDATA, character entities,
 * mixed content and self-closing elements all have a way of *half*-working, and a half-parsed
 * document yields a confidently wrong number — which is worse than a sensor that refuses to
 * answer. CLAUDE.md's rule is that syslog, NetFlow and WMI are written here **because npm has no
 * maintained option**; XML has several, and `fast-xml-parser` is pure JavaScript, actively
 * maintained, and carries one small transitive dependency. Writing one by hand would be inventing
 * a bug in the part that hurts most.
 *
 * **The tree it produces is read by `support/json-path.ts`, not by a second path engine.** That
 * is a deliberate divergence from `T-24`'s wording, which says "XPath extraction": two path
 * languages would be two things for an operator to learn, two to test and two to get subtly
 * wrong. What the path module gained instead is XPath *spelling* — a path beginning with `/` is
 * read as a location path, `[1]` counts from one the way XPath does, `@name` reaches an attribute
 * and `text()` an element's own text. Somebody who knows XPath writes what they expect; there is
 * one engine underneath it.
 *
 * **External entities are the reason to be careful here, and the answer is that they are off.**
 * `fast-xml-parser` expands no entity a DTD declares — a `billion laughs` document parses to the
 * literal text `&lol8;` rather than to a gigabyte — and it refuses a `SYSTEM` entity outright, so
 * neither `file:///etc/passwd` nor a URL it would fetch has anything to act on. Both of those are
 * properties of the library rather than of a setting we pass, which is exactly why there are
 * tests asserting them: a defence nobody checks is a defence that quietly disappears on an
 * upgrade.
 */

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

/**
 * What an attribute's key looks like in the tree.
 *
 * Prefixed rather than merged with the elements, because `<result name="x"><name>y</name></result>`
 * is a document where an attribute and a child element share a name — merging them would make one
 * of the two unreachable, and which one would depend on the order they were parsed in.
 */
export const ATTRIBUTE_PREFIX = '@_';

/** Where an element's own text lands when it also has attributes or children. */
export const TEXT_KEY = '#text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  textNodeName: TEXT_KEY,
  // **Numbers stay strings.** `parseTagValue` would turn `007` into 7 and a version like `1.10`
  // into 1.1, and this system has one place that decides what a string means — `numberFrom` in
  // the path module, which is also what reads a JSON API's quoted gauges.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // A single `<result>` and a list of them must have the same shape, or every path an operator
  // writes works until the day the document happens to have one entry in it. So every *element*
  // is an array — and attributes are not, because an attribute is single-valued by definition and
  // wrapping one would make `@state` a list nobody asked for.
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
  // Namespace prefixes are kept. Stripping them would make `<soap:Body>` and `<Body>` the same
  // element, which is wrong in precisely the documents where namespaces are load-bearing.
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: false,
});

/** Longer than any status document, and short enough that a parse is bounded. */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

/**
 * Parses XML, or says why it will not.
 *
 * Validated before it is parsed: `fast-xml-parser` is lenient by design and will happily produce
 * a tree from a truncated document, which is the case a monitoring check meets most often — a
 * response cut off by a bound or a connection. A tree built from half a document is the
 * confidently-wrong number this whole ticket is about avoiding.
 */
export function parseXml(text: string): Record<string, unknown> {
  if (text.length > MAX_XML_BYTES) {
    throw new XmlError(
      `the document is ${String(text.length)} bytes; the limit is ${String(MAX_XML_BYTES)}`,
    );
  }
  const trimmed = text.trim();
  if (trimmed === '') throw new XmlError('the response was empty');

  // `XMLValidator` is marked deprecated in favour of the `fast-xml-validator` package, and that
  // move is not worth making: measured, it adds **seven** packages — including a second XML
  // parser (`@nodable/flexible-xml-parser`), duplicate copies of two the parser already brings,
  // and two packages with install scripts — to replace an export that is present and works. The
  // day it is actually removed, the import fails at build time and this comment is the note on
  // what to do about it; a build that breaks loudly is the right failure here, because the
  // alternative is losing the validation below without anything saying so.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const valid = XMLValidator.validate(trimmed, { allowBooleanAttributes: true });
  if (valid !== true) {
    throw new XmlError(
      `this is not well-formed XML: ${valid.err.msg} (line ${String(valid.err.line)})`,
    );
  }

  // The library throws for a document it will not parse — a `SYSTEM` entity is the one that
  // matters — and that error arrives with no indication of which sensor or which response it came
  // from. Callers catch `XmlError`, so an escaping library error would be an unclassified failure
  // with a bare message; found by the external-entity test, which is the case it fires on.
  let tree: unknown;
  try {
    tree = parser.parse(trimmed);
  } catch (error) {
    throw new XmlError(
      `this XML could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
    throw new XmlError('the document has no root element');
  }
  return tree as Record<string, unknown>;
}

/**
 * Whether a response looks like XML, for the `auto` format.
 *
 * **HTML is excluded deliberately, and by more than a `<!DOCTYPE` check.** A proxy or a login
 * page answering with `<html><body>…` is *well-formed enough to parse as XML*, and a document
 * that parses turns the honest diagnosis — "this is not an API response" — into the useless one:
 * "your path matched nothing in it". Measured on this package's own fixture server, which is how
 * the too-narrow first version of this was found.
 *
 * A declaration or a labelled content type outranks the body, so XML served as
 * `application/json` — a real misconfiguration, and not a rare one — is still read as XML.
 */
export function looksLikeXml(text: string, contentType: string): boolean {
  if (/\b(?:application|text)\/(?:[\w.+-]+\+)?xml\b/i.test(contentType)) return true;
  const start = text.trimStart();
  if (start.startsWith('<?xml')) return true;
  if (/\btext\/html\b/i.test(contentType)) return false;
  if (/^<!doctype\s+html|^<html[\s>]/i.test(start)) return false;
  return start.startsWith('<');
}
