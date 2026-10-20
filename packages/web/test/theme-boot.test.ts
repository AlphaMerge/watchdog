import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The theme set before first paint (`U-23`).
 *
 * Walked in a browser against ms-core, the Credentials tab opened light with the operating system
 * asking for dark, and opened light again after the reader had chosen dark and reloaded. The
 * script that sets the theme was inline in `index.html`, and the core serves that page with
 * `default-src 'self'` (`hardening.ts`), which refuses inline script. The console said so; nothing
 * else did, because the Vite dev server sends no policy and the theme worked there.
 *
 * Read off disk from the package root, as `charts.test.ts` reads the stylesheet.
 */

const ROOT = process.cwd();
const page = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].map((match) => ({
  attributes: match[1] ?? '',
  body: match[2] ?? '',
}));

/** The classic script the page loads first, which is the theme's. */
const themeSource = /\bsrc="\/(theme-[0-9a-f]+\.js)"/u.exec(scripts[0]?.attributes ?? '')?.[1];

describe('the theme script', () => {
  // `setup.ts`'s stand-in, since jsdom has none; put back after each case replaces it.
  const held = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  afterEach(() => {
    vi.restoreAllMocks();
    if (held !== undefined) Object.defineProperty(window, 'matchMedia', held);
    delete document.documentElement.dataset['theme'];
    localStorage.clear();
  });

  it('is not inline in index.html, where the core’s Content-Security-Policy refuses it', () => {
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.attributes).toMatch(/\bsrc="/u);
      expect(script.body.trim()).toBe('');
    }
  });

  it('is the first script, in the head, and neither deferred nor a module, so it runs before first paint', () => {
    expect(themeSource).toBeDefined();
    const head = /<head>([\s\S]*?)<\/head>/u.exec(page)?.[1] ?? '';
    expect(head.includes(`src="/${themeSource ?? '(none)'}"`)).toBe(true);
    expect(scripts[0]?.attributes).not.toMatch(/\b(?:defer|async|type="module")/u);
  });

  it('is named for what is in it, since the core tells a browser to keep it for a year', () => {
    const file = resolve(ROOT, 'public', themeSource ?? '(none)');
    expect(existsSync(file)).toBe(true);
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8);
    // Changed it? Rename `public/theme-*.js` and the `src` in index.html to this.
    expect(themeSource).toBe(`theme-${hash}.js`);
  });

  describe('sets', () => {
    const run = (stored: string | null, prefersDark: boolean): string | undefined => {
      if (stored !== null) localStorage.setItem('ms-theme', stored);
      window.matchMedia = ((query: string) => ({
        matches: query === '(prefers-color-scheme: dark)' && prefersDark,
      })) as unknown as typeof window.matchMedia;
      const source = readFileSync(resolve(ROOT, 'public', themeSource ?? '(none)'), 'utf8');
      // The file under test, run as the page runs it: a classic script, at the top level.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- that is the point
      const boot = new Function(source) as () => void;
      boot();
      return document.documentElement.dataset['theme'];
    };

    it('dark where the reader chose it, whatever the operating system says', () => {
      expect(run('dark', false)).toBe('dark');
    });

    it('light where the reader chose it, whatever the operating system says', () => {
      expect(run('light', true)).toBe('light');
    });

    it('what the operating system asks for where the reader has not chosen', () => {
      expect(run(null, true)).toBe('dark');
      delete document.documentElement.dataset['theme'];
      expect(run(null, false)).toBe('light');
    });

    it('light where storage cannot be read', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      expect(run(null, true)).toBe('light');
    });
  });
});
