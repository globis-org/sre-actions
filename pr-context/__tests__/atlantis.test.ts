import { describe, expect, test } from 'vitest'
import {
  aggregateStatus,
  buildPlan,
  countsMatch,
  failureReason,
  lastSections,
  parseResourceLine,
  selectPlanComments,
  type StatusRecord,
} from '../src/atlantis'

// 実際の Atlantis コメントの構造を写したもの (パスや値は汎用のものに置き換えている)
const multiHead = `Ran Plan for 2 projects:

1. dir: \`infra/prod\` workspace: \`default\`
1. dir: \`infra/stg\` workspace: \`default\`
---

### 1. dir: \`infra/prod\` workspace: \`default\`
<details><summary>Show Output</summary>

\`\`\`diff
Terraform will perform the following actions:

  # aws_iam_role.a will be destroyed
  # (because aws_iam_role.a is not in configuration)
- resource "aws_iam_role" "a" {
\`\`\`
</details>

**Warning**: Output length greater than max comment size. Continued in next comment.`

const multiTail = `Continued plan output from previous comment.
<details><summary>Show Output</summary>

\`\`\`diff
    }

  # module.db.aws_db_instance.this["primary"] must be replaced
-/+ resource "aws_db_instance" "this" {
    }

Plan: 1 to add, 0 to change, 2 to destroy.
\`\`\`
</details>
Plan: 1 to add, 0 to change, 2 to destroy.

---
### 2. dir: \`infra/stg\` workspace: \`default\`
**Plan Failed**: This project is currently locked by an unapplied plan from pull #1. To continue, delete the lock from #1 or apply that plan and merge the pull request.

---
### Plan Summary

2 projects, 1 with changes, 0 unchanged, 1 failed`

const single = (dir: string, body: string): string =>
  `Ran Plan for dir: \`${dir}\` workspace: \`default\`\n\`\`\`diff\n${body}\n\`\`\``

const status = (
  context: string,
  state: string,
  description: string,
  at = '2026-01-01T00:00:00Z'
): StatusRecord => ({
  context,
  state,
  description,
  created_at: at,
})

const settled = {
  kind: 'settled',
  state: 'success',
  description: '2/2 projects planned successfully.',
  since: '2026-01-01T00:00:00Z',
} as const

describe('aggregateStatus', () => {
  test('uses the latest aggregate status and the time it first appeared', () => {
    expect(
      aggregateStatus([
        status(
          'atlantis/plan',
          'success',
          '1/1 projects planned successfully.',
          '2026-01-01T00:02:00Z'
        ),
        status(
          'atlantis/plan: infra/prod/default',
          'success',
          'No changes.',
          '2026-01-01T00:01:30Z'
        ),
        status('atlantis/plan', 'pending', 'Plan in progress...', '2026-01-01T00:01:00Z'),
      ])
    ).toStrictEqual({
      kind: 'settled',
      state: 'success',
      description: '1/1 projects planned successfully.',
      since: '2026-01-01T00:01:00Z',
    })
  })

  test.each([
    [[], 'none'],
    [[status('atlantis/plan', 'pending', 'Plan in progress...')], 'pending'],
  ])('%#', (statuses, kind) => {
    expect(aggregateStatus(statuses).kind).toBe(kind)
  })
})

const comment = (login: string, type: string, createdAt: string, body: string) => ({
  login,
  type,
  createdAt,
  body,
})

describe('selectPlanComments', () => {
  test('keeps bot plan comments after since in order and joins continued output', () => {
    expect(
      selectPlanComments(
        [
          comment('atlantis-bot[bot]', 'Bot', '2026-01-01T00:00:02Z', multiTail),
          comment('atlantis-bot[bot]', 'Bot', '2026-01-01T00:00:01Z', multiHead),
          comment('atlantis-bot[bot]', 'Bot', '2025-12-31T00:00:00Z', single('old', 'No changes.')),
          comment(
            'atlantis-bot[bot]',
            'Bot',
            '2026-01-01T00:00:03Z',
            'Ran Apply for dir: `infra/prod` workspace: `default`'
          ),
          comment(
            'atlantis-bot[bot]',
            'Bot',
            '2026-01-01T00:00:04Z',
            'Continued apply output from previous comment.'
          ),
          comment('atlantis-bot', 'User', '2026-01-01T00:00:05Z', single('fake', 'No changes.')),
          comment('someone', 'User', '2026-01-01T00:00:06Z', single('quoted', 'No changes.')),
        ],
        'atlantis-bot',
        '2026-01-01T00:00:00Z'
      )
    ).toStrictEqual([`${multiHead}\n${multiTail}`])
  })

  test('drops continued output whose head comment is older than since', () => {
    expect(
      selectPlanComments(
        [comment('atlantis-bot[bot]', 'Bot', '2026-01-01T00:00:01Z', multiTail)],
        'atlantis-bot[bot]',
        '2026-01-01T00:00:00Z'
      )
    ).toStrictEqual([])
  })
})

describe('lastSections', () => {
  test('splits by project, ignoring the table of contents, and keeps the last plan of each', () => {
    const sections = lastSections([
      `${multiHead}\n${multiTail}`,
      single('infra/stg', 'No changes.'),
    ])
    expect([...sections.keys()]).toStrictEqual(['infra/prod/default', 'infra/stg/default'])
    expect(sections.get('infra/prod/default')).toContain('must be replaced')
    expect(sections.get('infra/stg/default')).toContain('No changes.')
  })

  test('named projects are keyed by name like their statuses', () => {
    const sections = lastSections([
      'Ran Plan for project: `app` dir: `.` workspace: `prod`\nNo changes.',
    ])
    expect([...sections.keys()]).toStrictEqual(['app'])
  })
})

describe('parseResourceLine', () => {
  test.each([
    ['  # aws_s3_bucket.a will be created', 'aws_s3_bucket.a', 'create'],
    ['! # aws_iam_role.a will be updated in-place', 'aws_iam_role.a', 'update'],
    ['  # aws_instance.a (deposed object 1a2b) will be destroyed', 'aws_instance.a', 'delete'],
    ['-/+ # aws_instance.a must be replaced', 'aws_instance.a', 'replace'],
    ['  # aws_instance.a is tainted, so must be replaced', 'aws_instance.a', 'replace'],
    ['  # aws_instance.a will be replaced, as requested', 'aws_instance.a', 'replace'],
    ['  # aws_s3_bucket.a will be imported', 'aws_s3_bucket.a', 'import'],
    ['  # aws_s3_bucket.a will no longer be managed by Terraform', 'aws_s3_bucket.a', 'forget'],
    [
      '  # module.a["key with space"].aws_s3_bucket.this will be created',
      'module.a["key with space"].aws_s3_bucket.this',
      'create',
    ],
  ])('%s', (line, address, action) => {
    expect(parseResourceLine(line)).toStrictEqual({ address, action })
  })

  test('moved resources keep the previous address', () => {
    expect(parseResourceLine('  # aws_s3_bucket.a has moved to aws_s3_bucket.b')).toStrictEqual({
      address: 'aws_s3_bucket.b',
      action: 'move',
      previousAddress: 'aws_s3_bucket.a',
    })
  })

  test.each([
    '  # data.aws_iam_policy_document.a will be read during apply',
    '  # (because aws_instance.a is not in configuration)',
    '  # (moved from aws_s3_bucket.a)',
    '+ resource "aws_s3_bucket" "a" {',
  ])('ignores %s', line => {
    expect(parseResourceLine(line)).toBeNull()
  })
})

describe('countsMatch', () => {
  const resources = [
    { address: 'a', action: 'create' as const },
    { address: 'b', action: 'replace' as const },
    { address: 'c', action: 'update' as const },
    { address: 'd', action: 'delete' as const },
  ]

  test.each([
    ['Plan: 2 to add, 1 to change, 2 to destroy.', true],
    ['Plan: 5 to import, 2 to add, 1 to change, 2 to destroy.', true],
    ['Plan: 2 to add, 1 to change, 3 to destroy.', false],
    ['Plan: 2 to add, 1 to change, 2 to destroy, 1 to forget.', false],
  ])('%s', (line, expected) => {
    expect(countsMatch(line, resources)).toBe(expected)
  })
})

describe('failureReason', () => {
  test.each([
    ['**Plan Failed**: locked by #1', 'locked by #1'],
    ['**Plan Error**\n```\ncannot run "plan": locked\n```', 'cannot run "plan": locked'],
    ['No changes.', undefined],
  ])('%s', (text, expected) => {
    expect(failureReason(text)).toBe(expected)
  })
})

describe('buildPlan', () => {
  const comments = [`${multiHead}\n${multiTail}`]

  test('takes the state from statuses and the resources and reasons from comments', () => {
    const plan = buildPlan(
      settled,
      [
        status(
          'atlantis/plan: infra/prod/default',
          'success',
          'Plan: 1 to add, 0 to change, 2 to destroy.'
        ),
        status('atlantis/plan: infra/stg/default', 'failure', 'Plan failed.'),
      ],
      comments
    )
    expect(plan).toStrictEqual({
      state: 'failed',
      projects: [
        {
          project: 'infra/prod/default',
          state: 'changes',
          status: 'Plan: 1 to add, 0 to change, 2 to destroy.',
          resources: [
            { address: 'aws_iam_role.a', action: 'delete' },
            { address: 'module.db.aws_db_instance.this["primary"]', action: 'replace' },
          ],
        },
        {
          project: 'infra/stg/default',
          state: 'failed',
          status: 'Plan failed.',
          reason:
            'This project is currently locked by an unapplied plan from pull #1. To continue, delete the lock from #1 or apply that plan and merge the pull request.',
          resources: [],
        },
      ],
      resources: [
        { address: 'aws_iam_role.a', action: 'delete' },
        { address: 'module.db.aws_db_instance.this["primary"]', action: 'replace' },
      ],
    })
  })

  test('a later successful plan in the status overrides an earlier failure in the comments', () => {
    const plan = buildPlan(
      settled,
      [
        status(
          'atlantis/plan: infra/stg/default',
          'success',
          'No changes. Your infrastructure matches the configuration.'
        ),
      ],
      [...comments, single('infra/stg', 'No changes.')]
    )
    expect(plan.state).toBe('no-changes')
  })

  test.each([
    [
      'resources missing from the comment',
      'Plan: 1 to add, 0 to change, 3 to destroy.',
      comments,
      'リソース数が Plan 行と合わない',
    ],
    [
      'no comment for the project',
      'Plan: 1 to add, 0 to change, 0 to destroy.',
      [],
      'plan コメントが見つからない',
    ],
  ])('%s is incomplete', (_, description, planComments, reason) => {
    const plan = buildPlan(
      settled,
      [status('atlantis/plan: infra/prod/default', 'success', description)],
      planComments
    )
    expect(plan.state).toBe('incomplete')
    expect(plan.projects[0]?.reason).toBe(reason)
  })

  test('aggregate states without project statuses', () => {
    expect(buildPlan({ kind: 'pending' }, [], []).state).toBe('pending')
    expect(buildPlan({ kind: 'none' }, [], []).state).toBe('none')
    expect(
      buildPlan({ ...settled, description: '0/0 projects planned successfully.' }, [], []).state
    ).toBe('no-projects')
  })

  test('a command-level failure keeps its reason', () => {
    const plan = buildPlan(
      { ...settled, state: 'failure', description: 'Plan failed.' },
      [],
      ['**Plan Error**\n```\nparse error in atlantis.yaml\n```']
    )
    expect(plan.state).toBe('failed')
    expect(plan.projects[0]?.reason).toBe('parse error in atlantis.yaml')
  })
})
