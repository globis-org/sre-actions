import { describe, expect, test } from 'vitest'
import {
  buildPlan,
  collectHcpPlan,
  countsMatch,
  errorReason,
  renderWorkspaceLog,
  resourcesFromLog,
  workspaceStatuses,
} from '../src/hcp'
import { parsePlanLog } from '../src/hcp-log'
import type { PlanReader, PlanSummary } from '../src/tfc'
import { destroyOrReplace } from '../src/summary'

const RUN_URL = 'https://app.terraform.io/app/my-org/infra-app-prod/runs/run-abc123'

const line = (message: object): string => JSON.stringify({ '@level': 'info', ...message })

const plannedChange = (action: string, addr: string, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'planned_change',
    change: { resource: { addr }, action, ...extra },
  })

const changeSummary = (changes: {
  add: number
  change: number
  remove: number
  import: number
}): string => line({ type: 'change_summary', changes: { ...changes, operation: 'plan' } })

// 実ログで観測した形: 純 import は action が import、import と同時の update は update のまま importing が付く。
// move は planned_change に出るが change_summary に数えられず、data source の read は apply_start にしか出ない
const STRUCTURED_LOG = [
  'Terraform v1.16.0',
  'on linux_amd64',
  'Initializing plugins and modules...',
  line({ type: 'version', terraform: '1.16.0', ui: '1.3' }),
  line({
    type: 'apply_start',
    hook: { resource: { addr: 'data.aws_caller_identity.current' }, action: 'read' },
  }),
  plannedChange('create', 'aws_s3_bucket.logs'),
  plannedChange('update', 'aws_iam_role.app', { importing: { id: 'app-role' } }),
  plannedChange('import', 'aws_iam_policy.legacy', {
    importing: { id: 'arn:aws:iam::123456789012:policy/legacy' },
  }),
  plannedChange('replace', 'aws_instance.web[0]', { reason: 'cannot_update' }),
  plannedChange('delete', 'aws_instance.web[1]', { reason: 'delete_because_each_key' }),
  plannedChange('move', 'module.app.aws_sqs_queue.this', {
    previous_resource: { addr: 'aws_sqs_queue.app' },
  }),
  plannedChange('read', 'data.aws_ami.deferred', { reason: 'read_because_config_unknown' }),
  plannedChange('noop', 'aws_s3_bucket.unchanged'),
  line({
    type: 'diagnostic',
    diagnostic: {
      severity: 'warning',
      summary: 'Deprecated value used',
      address: 'aws_iam_role.app',
    },
  }),
  changeSummary({ add: 2, change: 1, remove: 2, import: 2 }),
].join('\n')

const TEXT_LOG = [
  'Terraform v1.16.0',
  'on linux_amd64',
  'Initializing plugins and modules...',
  'Terraform used the selected providers to generate the following execution plan.',
  '',
  '  # aws_s3_bucket.logs will be created',
  '  + resource "aws_s3_bucket" "logs" {',
  '      + bucket = "logs"',
  '    }',
  '',
  '  # aws_instance.web must be replaced',
  '-/+ resource "aws_instance" "web" {',
  '      ~ ami = "ami-old" -> "ami-new" # forces replacement',
  '    }',
  '',
  'Plan: 2 to add, 0 to change, 1 to destroy.',
].join('\n')

// init で失敗した run のログは structured の workspace でも JSON 行を含まない
const ERRORED_LOG = [
  'Terraform v1.16.0',
  'on linux_amd64',
  'Initializing plugins and modules...',
  '╷',
  '│ Error: Unsupported Terraform Core version',
  '│ ',
  '│   on versions.tf line 2, in terraform:',
  '│    2:   required_version = "1.15.0"',
  '│ ',
  '│ This configuration does not support Terraform version 1.16.0.',
  '╵',
  '',
  'Operation failed: failed running terraform init (exit 1)',
].join('\n')

const summary = (overrides: Partial<PlanSummary> = {}): PlanSummary => ({
  hasChanges: true,
  additions: 2,
  changes: 1,
  destructions: 2,
  logReadUrl: 'https://archivist.example/log',
  ...overrides,
})

function reader(
  plans: Record<string, PlanSummary | null>,
  logs: Record<string, string>
): PlanReader {
  return {
    getPlanForRun: async runId => {
      if (!(runId in plans)) {
        throw new Error(
          `HCP Terraform API request failed: GET /runs/${runId}/plan -> 403 Forbidden`
        )
      }
      return plans[runId] ?? null
    },
    fetchLog: async url => {
      const log = logs[url]
      if (log === undefined) {
        throw new Error(`Failed to fetch plan log: 404 Not Found`)
      }
      return log
    },
  }
}

const status = (
  workspace: string,
  state: string,
  description: string,
  targetUrl: string | null = RUN_URL
): { context: string; state: string; target_url: string | null; description: string | null } => ({
  context: `Terraform Cloud/my-org/${workspace}`,
  state,
  target_url: targetUrl,
  description,
})

describe('workspaceStatuses', () => {
  test('keeps the latest status per workspace of the organization, sorted by name', () => {
    const result = workspaceStatuses(
      [
        status('infra-app-stg', 'success', 'Terraform plan: 0 to add, 0 to change, 0 to destroy.'),
        status('infra-app-prod', 'success', 'Terraform plan: 1 to add, 0 to change, 0 to destroy.'),
        status('infra-app-prod', 'pending', 'Terraform plan is running...'),
        {
          context: 'Terraform Cloud/other-org/infra',
          state: 'pending',
          target_url: null,
          description: null,
        },
        { context: 'atlantis/plan', state: 'success', target_url: null, description: null },
      ],
      'my-org'
    )
    expect([...result.keys()]).toStrictEqual(['infra-app-prod', 'infra-app-stg'])
    expect(result.get('infra-app-prod')?.kind).toBe('finished')
  })
})

describe('resourcesFromLog', () => {
  test('maps structured actions and drops read / noop', () => {
    expect(resourcesFromLog(parsePlanLog(STRUCTURED_LOG))).toStrictEqual([
      { address: 'aws_s3_bucket.logs', action: 'create' },
      { address: 'aws_iam_role.app', action: 'update' },
      { address: 'aws_iam_policy.legacy', action: 'import' },
      { address: 'aws_instance.web[0]', action: 'replace' },
      { address: 'aws_instance.web[1]', action: 'delete' },
      {
        address: 'module.app.aws_sqs_queue.this',
        action: 'move',
        previousAddress: 'aws_sqs_queue.app',
      },
    ])
  })

  test('parses text (Console UI) logs with the Atlantis resource line parser', () => {
    expect(resourcesFromLog(parsePlanLog(TEXT_LOG))).toStrictEqual([
      { address: 'aws_s3_bucket.logs', action: 'create' },
      { address: 'aws_instance.web', action: 'replace' },
    ])
  })
})

describe('countsMatch', () => {
  const resources = resourcesFromLog(parsePlanLog(STRUCTURED_LOG))

  test('replace counts as add and destroy; import, move are not counted', () => {
    expect(countsMatch({ additions: 2, changes: 1, destructions: 2 }, resources)).toBe(true)
  })

  test('detects a truncated list', () => {
    expect(countsMatch({ additions: 3, changes: 1, destructions: 2 }, resources)).toBe(false)
  })
})

describe('errorReason', () => {
  test('uses the error diagnostic of a structured log', () => {
    const log = parsePlanLog(
      [
        line({
          type: 'diagnostic',
          diagnostic: { severity: 'error', summary: 'Unsupported attribute', detail: '...' },
        }),
        line({ '@level': 'error', '@message': 'Terraform exited with code 1' }),
      ].join('\n')
    )
    expect(errorReason(log)).toBe('Error: Unsupported attribute')
  })

  test('uses the Error line of a text log', () => {
    expect(errorReason(parsePlanLog(ERRORED_LOG))).toBe('Error: Unsupported Terraform Core version')
  })

  test('falls back to the trailing Operation failed line', () => {
    expect(
      errorReason(parsePlanLog('Operation failed: failed running terraform init (exit 1)'))
    ).toBe('Operation failed: failed running terraform init (exit 1)')
    expect(errorReason(null)).toBeUndefined()
  })
})

describe('renderWorkspaceLog', () => {
  test('renders the change list and diagnostics of a structured log', () => {
    const text = renderWorkspaceLog('infra-app-prod', RUN_URL, parsePlanLog(STRUCTURED_LOG))
    expect(text).toBe(
      [
        '## infra-app-prod',
        '',
        `run: ${RUN_URL}`,
        '',
        '```',
        'Warning: Deprecated value used',
        '',
        '  with aws_iam_role.app',
        '```',
        '',
        '```diff',
        '+   create  aws_s3_bucket.logs',
        '!   update  aws_iam_role.app',
        '+   import  aws_iam_policy.legacy',
        '-/+ replace aws_instance.web[0] (cannot_update)',
        '-   destroy aws_instance.web[1] (delete_because_each_key)',
        '>   move    module.app.aws_sqs_queue.this (from aws_sqs_queue.app)',
        '<=  read    data.aws_ami.deferred (read_because_config_unknown)',
        '    noop    aws_s3_bucket.unchanged',
        '```',
        '',
      ].join('\n')
    )
  })

  test('renders the plan body of a text log', () => {
    const text = renderWorkspaceLog('infra-app-prod', null, parsePlanLog(TEXT_LOG))
    expect(text.startsWith('## infra-app-prod\n\n```\nTerraform used the selected providers')).toBe(
      true
    )
    expect(text.endsWith('Plan: 2 to add, 0 to change, 1 to destroy.\n```\n')).toBe(true)
  })
})

describe('collectHcpPlan', () => {
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
  }

  test('verifies resources against the plan API counts', async () => {
    const workspaces = workspaceStatuses(
      [
        status('infra-app-prod', 'success', 'Terraform plan: 2 to add, 1 to change, 2 to destroy.'),
        status(
          'infra-app-stg',
          'success',
          'Terraform plan: 0 to add, 0 to change, 0 to destroy.',
          RUN_URL.replace('run-abc123', 'run-stg')
        ),
        status(
          'infra-tools',
          'success',
          'Run not triggered: Terraform working directories did not change.',
          null
        ),
      ],
      'my-org'
    )
    const { plan, latest } = await collectHcpPlan(
      reader(
        {
          'run-abc123': summary(),
          'run-stg': summary({
            hasChanges: false,
            additions: 0,
            changes: 0,
            destructions: 0,
          }),
        },
        { 'https://archivist.example/log': STRUCTURED_LOG }
      ),
      workspaces,
      warn
    )
    expect(plan.state).toBe('changes')
    expect(plan.projects.map(p => [p.project, p.state, p.reason])).toStrictEqual([
      ['infra-app-prod', 'changes', undefined],
      ['infra-app-stg', 'no-changes', undefined],
      ['infra-tools', 'untriggered', undefined],
    ])
    expect(plan.projects[0]?.status).toBe('Terraform plan: 2 to add, 1 to change, 2 to destroy.')
    expect(plan.resources.map(r => `${r.project}:${r.address}:${r.action}`)).toStrictEqual([
      'infra-app-prod:aws_s3_bucket.logs:create',
      'infra-app-prod:aws_iam_role.app:update',
      'infra-app-prod:aws_iam_policy.legacy:import',
      'infra-app-prod:aws_instance.web[0]:replace',
      'infra-app-prod:aws_instance.web[1]:delete',
      'infra-app-prod:module.app.aws_sqs_queue.this:move',
    ])
    expect(destroyOrReplace(plan)).toBe('true')
    // no-changes の workspace と untriggered の workspace は latest に出さない
    expect(latest.match(/^## /gm)).toStrictEqual(['## '])
    expect(warnings).toStrictEqual([])
  })

  test('marks a workspace incomplete when the counts do not match, and keeps the resources', async () => {
    const { plan } = await collectHcpPlan(
      reader(
        { 'run-abc123': summary({ additions: 3 }) },
        { 'https://archivist.example/log': STRUCTURED_LOG }
      ),
      workspaceStatuses(
        [
          status(
            'infra-app-prod',
            'success',
            'Terraform plan: 3 to add, 1 to change, 2 to destroy.'
          ),
        ],
        'my-org'
      ),
      warn
    )
    expect(plan.state).toBe('incomplete')
    expect(plan.projects[0]?.reason).toBe('リソース数が plan の件数と合わない')
    expect(plan.resources).toHaveLength(6)
    expect(destroyOrReplace(plan)).toBe('true')
  })

  test('reports an errored run with the reason from its log', async () => {
    const { plan, latest } = await collectHcpPlan(
      reader(
        {
          'run-abc123': summary({ hasChanges: false, logReadUrl: 'https://archivist.example/err' }),
        },
        { 'https://archivist.example/err': ERRORED_LOG }
      ),
      workspaceStatuses([status('infra-app-prod', 'failure', 'Terraform plan errored.')], 'my-org'),
      warn
    )
    expect(plan.state).toBe('failed')
    expect(plan.projects[0]).toMatchObject({
      state: 'failed',
      status: 'Terraform plan errored.',
      reason: 'Error: Unsupported Terraform Core version',
    })
    expect(latest).toContain('Operation failed: failed running terraform init (exit 1)')
    expect(destroyOrReplace(plan)).toBe('unknown')
  })

  test('errored run without a plan (404) is still failed', async () => {
    const { plan } = await collectHcpPlan(
      reader({ 'run-abc123': null }, {}),
      workspaceStatuses([status('infra-app-prod', 'error', 'Terraform plan errored.')], 'my-org'),
      warn
    )
    expect(plan.projects[0]).toStrictEqual({
      project: 'infra-app-prod',
      state: 'failed',
      status: 'Terraform plan errored.',
      resources: [],
    })
  })

  test('API failures become incomplete with a warning instead of failing the action', async () => {
    warnings.length = 0
    const { plan } = await collectHcpPlan(
      reader({}, {}),
      workspaceStatuses(
        [
          status(
            'infra-app-prod',
            'success',
            'Terraform plan: 1 to add, 0 to change, 0 to destroy.'
          ),
        ],
        'my-org'
      ),
      warn
    )
    expect(plan.state).toBe('incomplete')
    expect(plan.projects[0]?.reason).toBe(
      'HCP Terraform API: HCP Terraform API request failed: GET /runs/run-abc123/plan -> 403 Forbidden'
    )
    expect(warnings).toHaveLength(1)
  })

  test('a no-changes workspace does not read the log, so a broken log URL does not make it incomplete', async () => {
    const calls: string[] = []
    const base = reader(
      { 'run-abc123': summary({ hasChanges: false, additions: 0, changes: 0, destructions: 0 }) },
      {}
    )
    const { plan } = await collectHcpPlan(
      {
        ...base,
        fetchLog: url => {
          calls.push(url)
          return base.fetchLog(url)
        },
      },
      workspaceStatuses(
        [
          status(
            'infra-app-prod',
            'success',
            'Terraform plan: 0 to add, 0 to change, 0 to destroy.'
          ),
        ],
        'my-org'
      ),
      warn
    )
    expect(plan.state).toBe('no-changes')
    expect(calls).toStrictEqual([])
  })

  test('a failed log fetch on a workspace with changes is incomplete', async () => {
    warnings.length = 0
    const { plan } = await collectHcpPlan(
      reader({ 'run-abc123': summary() }, {}),
      workspaceStatuses(
        [
          status(
            'infra-app-prod',
            'success',
            'Terraform plan: 2 to add, 1 to change, 2 to destroy.'
          ),
        ],
        'my-org'
      ),
      warn
    )
    expect(plan.state).toBe('incomplete')
    expect(plan.projects[0]?.reason).toBe(
      'HCP Terraform API: Failed to fetch plan log: 404 Not Found'
    )
    expect(warnings).toHaveLength(1)
  })

  test('pending workspaces make the plan pending but settled workspaces are still verified', async () => {
    const { plan } = await collectHcpPlan(
      reader({ 'run-abc123': summary() }, { 'https://archivist.example/log': STRUCTURED_LOG }),
      workspaceStatuses(
        [
          status(
            'infra-app-prod',
            'success',
            'Terraform plan: 2 to add, 1 to change, 2 to destroy.'
          ),
          status('infra-app-stg', 'pending', 'Terraform plan is running...', null),
        ],
        'my-org'
      ),
      warn
    )
    expect(plan.state).toBe('pending')
    expect(plan.projects[1]).toMatchObject({ state: 'pending' })
    expect(destroyOrReplace(plan)).toBe('true')
  })
})

describe('buildPlan', () => {
  test('none without statuses, no-projects when nothing was triggered', () => {
    expect(buildPlan([]).state).toBe('none')
    const untriggered = buildPlan([
      {
        project: 'infra-app-prod',
        state: 'untriggered',
        status: 'Run not triggered',
        resources: [],
      },
    ])
    expect(untriggered.state).toBe('no-projects')
    expect(destroyOrReplace(untriggered)).toBe('false')
  })

  test('untriggered never wins over a settled workspace', () => {
    const plan = buildPlan([
      { project: 'a', state: 'untriggered', status: '', resources: [] },
      { project: 'b', state: 'no-changes', status: '', resources: [] },
    ])
    expect(plan.state).toBe('no-changes')
  })
})
