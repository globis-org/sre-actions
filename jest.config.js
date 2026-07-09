/** @type {import('jest').Config} */
module.exports = {
  projects: [
    '<rootDir>/aws-ssm-parameters',
    '<rootDir>/codeowners-validator',
    '<rootDir>/deploybot',
    '<rootDir>/docker-image-tag',
  ],
  verbose: true,
}
