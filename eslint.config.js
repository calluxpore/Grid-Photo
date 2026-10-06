const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', '.venv/**', 'legacy/**'] },
  js.configs.recommended,
  {
    files: ['electron/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
