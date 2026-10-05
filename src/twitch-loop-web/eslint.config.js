const parser = require('@typescript-eslint/parser');
const plugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser, parserOptions: { project: './tsconfig.json', sourceType: 'module' } },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
];
