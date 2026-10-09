import * as core from '@actions/core'

export type Inputs = {
  githubToken: string
  // 省略時はイベントの payload から取る
  pullRequestNumber: number | null
  outputDir: string
  // 空なら Atlantis プロバイダを無効にする
  atlantisCommentAuthor: string
  atlantisStatusContext: string
  maxWaitTime: number
  startTimeout: number
  pollInterval: number
}

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Input "${name}" must be a positive integer, got "${raw}"`)
  }
  return value
}

function parseNonNegativeInt(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Input "${name}" must be a non-negative integer, got "${raw}"`)
  }
  return value
}

export function getInputs(): Inputs {
  const pullRequestNumber = core.getInput('pull-request-number')
  return {
    githubToken: core.getInput('github-token', { required: true }),
    pullRequestNumber:
      pullRequestNumber === '' ? null : parsePositiveInt('pull-request-number', pullRequestNumber),
    outputDir: core.getInput('output-dir') || '.claude-review',
    atlantisCommentAuthor: core.getInput('atlantis-comment-author'),
    atlantisStatusContext: core.getInput('atlantis-status-context') || 'atlantis/plan',
    maxWaitTime: parseNonNegativeInt('max-wait-time', core.getInput('max-wait-time') || '600'),
    startTimeout: parseNonNegativeInt('start-timeout', core.getInput('start-timeout') || '120'),
    pollInterval: parsePositiveInt('poll-interval', core.getInput('poll-interval') || '10'),
  }
}

// pull_request 系のイベントと、PR 上の issue_comment で PR 番号を取る
export function pullRequestNumberFromPayload(payload: Record<string, unknown>): number | null {
  const pullRequest = payload['pull_request'] as { number?: number } | undefined
  if (typeof pullRequest?.number === 'number') {
    return pullRequest.number
  }
  const issue = payload['issue'] as { number?: number; pull_request?: unknown } | undefined
  if (typeof issue?.number === 'number' && issue.pull_request !== undefined) {
    return issue.number
  }
  return null
}
