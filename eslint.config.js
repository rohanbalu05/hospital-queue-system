// ESLint flat config: typescript-eslint "strict" (syntactic, not type-aware, so it works on any
// package without per-package tsconfig wiring; type errors are covered by `pnpm typecheck`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/var/**',
      '**/*.d.ts',
      'apps/web/src/components/ui/**', // shadcn/ui generated components
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // NestJS uses empty decorated classes (modules).
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Runtime logging, CLIs and test tooling may print.
    files: ['**/*.test.ts', 'tests/**', 'scripts/**', 'packages/db/**', 'apps/worker/**', 'apps/api/src/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
