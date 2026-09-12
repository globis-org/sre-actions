import * as core from '@actions/core'

export type Inputs = {
  token: string
  organization: string
  hostname: string
  workspaces: string[]
  githubToken: string
  pullRequestNumber: number
  maxWaitTime: number
  pollInterval: number
  failOnTimeout: boolean
  failOnError: boolean
  comment: boolean
  showUntriggered: boolean
  statusContext: string
  hcpStatusPrefix: string
}

// カンマ区切りまたは改行区切りの文字列を配列に変換する
export function splitList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .flatMap(line => line.split(','))
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Input "${name}" must be a positive integer, got "${raw}"`)
  }
  return value
}

export function getInputs(): Inputs {
  return {
    token: core.getInput('token', { required: true }),
    organization: core.getInput('organization', { required: true }),
    hostname: core.getInput('hostname') || 'app.terraform.io',
    workspaces: splitList(core.getInput('workspaces')),
    githubToken: core.getInput('github-token', { required: true }),
    pullRequestNumber: parsePositiveInt(
      'pull-request-number',
      core.getInput('pull-request-number')
    ),
    maxWaitTime: parsePositiveInt('max-wait-time', core.getInput('max-wait-time')),
    pollInterval: parsePositiveInt('poll-interval', core.getInput('poll-interval')),
    failOnTimeout: core.getBooleanInput('fail-on-timeout'),
    failOnError: core.getBooleanInput('fail-on-error'),
    comment: core.getBooleanInput('comment'),
    showUntriggered: core.getBooleanInput('show-untriggered'),
    statusContext: core.getInput('status-context'),
    hcpStatusPrefix: core.getInput('hcp-status-prefix') || 'Terraform Cloud/',
  }
}
