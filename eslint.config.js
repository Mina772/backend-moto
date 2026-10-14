import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/coverage/**', 'audit/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: { ...globals.node, ...globals.es2022 } } },
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
);
