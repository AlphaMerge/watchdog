// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    // `build/` is the packaging staging area and `release/` the tarballs it produces — both
    // gitignored, both full of compiled output, and `**/dist/**` does not cover the web assets
    // staged under `build/ms-*/web/`.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'build/**',
      'release/**',
      // Agent worktrees are whole copies of this repository, build output and all. Linting one
      // means linting everything twice and reporting thousands of errors from a minified bundle
      // that no one committed — and the patterns above are anchored to the repository root, so
      // a nested checkout's `build/` is not covered by them.
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: no `any` in committed code.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // node:test's describe/it return promises that the runner owns; they are not ours to await.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: [
                'describe',
                'it',
                'test',
                'before',
                'after',
                'beforeEach',
                'afterEach',
                'suite',
              ],
            },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // CLAUDE.md: never console.log in packages/ — structured logs only. The browser is no
    // exception: a stray console.log ships to every user's devtools and says nothing useful.
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // The rules of hooks are not style. A missing dependency is a stale closure, and a
    // conditional hook is a crash — both of which type-checking cannot see.
    files: ['packages/web/**/*.ts', 'packages/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // A module that exports a component and anything else cannot Fast Refresh. Editing it drops
    // the hot update and reloads the page instead, which fails silently: it costs a couple of
    // seconds and whatever UI state was open, and nothing reports it but a line in the dev
    // console. `whereSteps` sat in `AlarmsView.tsx` like that until somebody read one.
    //
    // `src` only. The rule describes what Vite's refresh boundaries need, and `test/` is not in
    // that module graph — a helper exported beside a rendered fixture there costs nothing.
    files: ['packages/web/src/**/*.ts', 'packages/web/src/**/*.tsx'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      // `allowConstantExport` matches what the runtime already tolerates: it permits literals,
      // template and arithmetic expressions — the values that stay identical across a module
      // re-evaluation — and still rejects the arrays, objects and functions that do not.
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    // Config files and plain scripts sit outside the TypeScript projects, so the type-aware
    // rules have nothing to work with. They do run on Node, though — without its globals
    // declared, `process` and `Buffer` read as undefined variables in every one of them.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
  prettier,
);
