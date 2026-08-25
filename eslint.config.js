// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

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
    // Config files and plain scripts sit outside the TypeScript projects, so the type-aware
    // rules have nothing to work with.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
  prettier,
);
