import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseInline } from '../src/components/inline-markdown';
import { SchemaForm } from '../src/forms/SchemaForm';
import type { JsonSchema } from '../src/forms/schema';

/**
 * A schema's description, drawn as the Markdown it is written in (`U-89`).
 *
 * Walked in a browser (`U-23`), the Credentials tab showed the catalogue's backticks as typed —
 * "Give it `SELECT` on what it is watching" — where `docs/sensor-reference.md`, generated from the
 * same text, shows code. The cases below are the catalogue's own sentences where a sentence has
 * the shape in question, so what is held is what an operator is shown.
 */

const text = (value: string) => ({ kind: 'text', text: value }) as const;
const code = (value: string) => ({ kind: 'code', text: value }) as const;

describe('a description, read', () => {
  it('reads a code span as code, without its backticks', () => {
    expect(parseInline('Give it `SELECT` on what it is watching and nothing else')).toEqual([
      text('Give it '),
      code('SELECT'),
      text(' on what it is watching and nothing else'),
    ]);
  });

  it('reads emphasis and strong emphasis, and strong around a code span', () => {
    expect(parseInline('two credential *sets* of this one kind')).toEqual([
      text('two credential '),
      { kind: 'em', children: [text('sets')] },
      text(' of this one kind'),
    ]);
    expect(parseInline('**Each name starts with `MS_VAR_`**, then capitals')).toEqual([
      { kind: 'strong', children: [text('Each name starts with '), code('MS_VAR_')] },
      text(', then capitals'),
    ]);
  });

  it('leaves a star that opens or closes nothing as a star', () => {
    // Each is in a description as written, and each is a star on the generated page too.
    for (const sentence of [
      'host names, *.domain patterns, addresses and CIDR ranges, inside a name or a *.domain that covers it',
      '$.queue.depth · $.nodes[*].load · $..load',
      'After {{substitution}}. {{credential.*}} is accepted only in an Authorization header',
      'whatever arrived through MS_* overrides',
      'a star * on its own, and two ** of them',
    ]) {
      expect(parseInline(sentence)).toEqual([text(sentence)]);
    }
  });

  it('leaves underscores inside a word alone, and a backtick nothing closes', () => {
    expect(parseInline('needs CAP_NET_RAW and MS_VAR_NAME')).toEqual([
      text('needs CAP_NET_RAW and MS_VAR_NAME'),
    ]);
    expect(parseInline('a ` that `` closes nothing')).toEqual([text('a ` that `` closes nothing')]);
    expect(parseInline('_a word_ emphasised')).toEqual([
      { kind: 'em', children: [text('a word')] },
      text(' emphasised'),
    ]);
  });

  it('takes a code span as written: a longer fence holds a backtick, and stars in one are text', () => {
    expect(parseInline('the `` a`b `` span')).toEqual([text('the '), code('a`b'), text(' span')]);
    expect(parseInline('`*not emphasis*` and `\\d+`')).toEqual([
      code('*not emphasis*'),
      text(' and '),
      code('\\d+'),
    ]);
  });

  it('takes a backslash before punctuation as that punctuation, and before anything else as itself', () => {
    expect(parseInline('a literal \\*star\\* and \\`tick\\`')).toEqual([
      text('a literal *star* and `tick`'),
    ]);
    expect(parseInline('“C:\\ Label:System”')).toEqual([text('“C:\\ Label:System”')]);
  });
});

describe('a description, drawn', () => {
  const SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        title: 'User name',
        description: 'A monitoring account, with `SELECT` on what it is watching.',
      },
      tls: {
        type: 'object',
        title: 'TLS',
        description: '`prefer` tries TLS and carries on *without* it.',
        properties: { mode: { enum: ['prefer', 'require'] } },
      },
      zones: {
        type: 'array',
        title: 'Blocklists',
        description: 'A message must satisfy **all** of these, `zen.spamhaus.org` among them.',
        items: { type: 'string', title: 'Blocklist' },
      },
    },
  };

  it('draws code, emphasis and strong in a field’s, a group’s and a list’s description, with no Markdown left in the text', () => {
    render(
      <SchemaForm
        schema={SCHEMA}
        values={{}}
        redacted={[]}
        onChange={() => undefined}
        replacing={new Set()}
        onReplace={() => undefined}
      />,
    );

    // The field's, which is also what its box is described by.
    const box = screen.getByLabelText('User name');
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('A monitoring account, with SELECT on what it is watching.');
    expect(hint?.querySelector('code')?.textContent).toBe('SELECT');

    // The group's and the list's, each under its legend.
    const group = screen.getByRole('group', { name: 'TLS' });
    const said = group.querySelector('p');
    expect(said?.textContent).toBe('prefer tries TLS and carries on without it.');
    expect(said?.querySelector('code')?.textContent).toBe('prefer');
    expect(said?.querySelector('em')?.textContent).toBe('without');

    const list = screen.getByRole('group', { name: 'Blocklists' });
    const listSaid = list.querySelector('p');
    expect(listSaid?.textContent).toBe(
      'A message must satisfy all of these, zen.spamhaus.org among them.',
    );
    expect(listSaid?.querySelector('strong')?.textContent).toBe('all');
    expect(listSaid?.querySelector('code')?.textContent).toBe('zen.spamhaus.org');

    expect(document.body.textContent).not.toMatch(/[`*]/u);
  });
});
