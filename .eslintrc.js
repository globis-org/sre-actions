/** @type {import('@typescript-eslint/experimental-utils').TSESLint.Linter.Config} */
module.exports = {
  env: {
    node: true,
    es6: true,
  },
  extends: ['globis/base', 'plugin:jest/recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    project: './tsconfig.eslint.json',
    sourceType: 'module',
  },
  plugins: ['jest'],
}
