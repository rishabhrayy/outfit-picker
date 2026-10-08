import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

// Checks that catch real bugs rather than style: names that don't exist,
// code that's never used, and React hooks called conditionally (a hook after
// an early return breaks the screen the first time that return is taken).
export default [
  { ignores: ['dist/**', 'node_modules/**', 'outputs/**', 'work/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^unused', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['server/**/*.js', 'api/**/*.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
];
