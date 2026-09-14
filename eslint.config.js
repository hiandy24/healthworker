import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.wrangler/**',
      '.local/**',
      'node_modules/**',
      'migrations/meta/**',
      // Agent skill 资产（文档、shell、按需复制进 tests/ 的复现模板）不在应用源码内，也不在
      // tsconfig 的 project 中；复制到 tests/integration 后照常被 lint 与 typecheck 覆盖。
      '.agents/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parserOptions: { project: './tsconfig.json' } },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: ['**/worker/**'] }],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/worker/**', '**/web/**', 'node:*'] },
      ],
    },
  },
);
