/** @type {import('jest').Config} */
module.exports = {
  transform: {
    '^.+\\.tsx?$': '@swc/jest',
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@actions/github$': '<rootDir>/__mocks__/@actions/github.js',
    '^@actions/exec$': '<rootDir>/__mocks__/@actions/exec.js',
  },
}
