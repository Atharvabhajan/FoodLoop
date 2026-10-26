import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts', 'apps/api/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser walkthroughs run in Node; `document` and `fetch` are used inside code evaluated in the page.
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', document: 'readonly', fetch: 'readonly', URL: 'readonly', setTimeout: 'readonly' } },
  },
);
