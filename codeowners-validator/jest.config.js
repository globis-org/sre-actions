const baseConfig = require('../jest.config.js')

module.exports = {
  ...baseConfig,
  rootDir: '..',
  testMatch: ['<rootDir>/codeowners-validator/__tests__/**/*.test.ts'],
}
