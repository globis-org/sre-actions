/** @type {import('jest').Config} */
module.exports = {
  transform: {
    '^.+\\.tsx?$': '@swc/jest',
  },
  testEnvironment: 'node',
}
