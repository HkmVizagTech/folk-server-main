'use strict';

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
  clearTimeout: 'readonly', clearInterval: 'readonly', URLSearchParams: 'readonly', __dirname: 'readonly',
  fetch: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^(req|res|next|data|context)$', ignoreRestSiblings: true }],
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
    },
  },
];
