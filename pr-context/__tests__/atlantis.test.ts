import { describe, expect, test } from 'vitest'
import { parsePlanComments, parseResourceLine, selectPlanComments } from '../src/atlantis'

const BOT = 'atlantis-bot'

const singleProject = `Ran Plan for dir: \`infra/app\` workspace: \`default\`

<details><summary>Show Output</summary>

\`\`\`diff

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
+ create
~ update in-place
- destroy
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # aws_s3_bucket.logs will be created
+ resource "aws_s3_bucket" "logs" {
+     bucket = "example-logs"
    }

  # aws_iam_role.app will be updated in-place
! resource "aws_iam_role" "app" {
        name = "app"
    }

  # aws_instance.old will be destroyed
  # (because aws_instance.old is not in configuration)
- resource "aws_instance" "old" {
    }

  # module.db.aws_db_instance.this["primary"] must be replaced
-/+ resource "aws_db_instance" "this" {
    }

Plan: 2 to add, 1 to change, 2 to destroy.
\`\`\`

* :arrow_forward: To **apply** this plan, comment:
    * \`atlantis apply -d infra/app\`
</details>
Plan: 2 to add, 1 to change, 2 to destroy.`

const multiProject = `Ran Plan for 2 projects:

1. dir: \`infra/a\` workspace: \`default\`
1. dir: \`infra/b\` workspace: \`default\`

### 1. dir: \`infra/a\` workspace: \`default\`
\`\`\`diff

No changes. Your infrastructure matches the configuration.
\`\`\`

---
### 2. dir: \`infra/b\` workspace: \`default\`
**Plan Error**
\`\`\`
Error: Invalid reference
\`\`\`

---
`

describe('parseResourceLine', () => {
  test.each([
    ['  # aws_s3_bucket.logs will be created', 'aws_s3_bucket.logs', 'create'],
    ['  # aws_iam_role.app will be updated in-place', 'aws_iam_role.app', 'update'],
    ['! # aws_iam_role.app will be updated in-place', 'aws_iam_role.app', 'update'],
    ['  # aws_instance.old will be destroyed', 'aws_instance.old', 'delete'],
    [
      '  # aws_instance.old (deposed object 1a2b3c) will be destroyed',
      'aws_instance.old',
      'delete',
    ],
    ['-/+ # aws_instance.web must be replaced', 'aws_instance.web', 'replace'],
    ['  # aws_instance.web is tainted, so must be replaced', 'aws_instance.web', 'replace'],
    ['  # aws_instance.web will be replaced, as requested', 'aws_instance.web', 'replace'],
    ['  # aws_s3_bucket.imported will be imported', 'aws_s3_bucket.imported', 'import'],
    [
      '  # aws_s3_bucket.kept will no longer be managed by Terraform',
      'aws_s3_bucket.kept',
      'forget',
    ],
    [
      '  # module.a["key with space"].aws_s3_bucket.this will be created',
      'module.a["key with space"].aws_s3_bucket.this',
      'create',
    ],
  ])('%s', (line, address, action) => {
    expect(parseResourceLine(line)).toStrictEqual({ address, action })
  })

  test('moved resources keep the previous address', () => {
    expect(parseResourceLine('  # aws_s3_bucket.old has moved to aws_s3_bucket.new')).toStrictEqual(
      {
        address: 'aws_s3_bucket.new',
        action: 'move',
        previousAddress: 'aws_s3_bucket.old',
      }
    )
  })

  test.each([
    '  # data.aws_iam_policy_document.this will be read during apply',
    '  # (because aws_instance.old is not in configuration)',
    '  # (moved from aws_s3_bucket.old)',
    '+ resource "aws_s3_bucket" "logs" {',
  ])('ignores %s', line => {
    expect(parseResourceLine(line)).toBeNull()
  })
})

describe('selectPlanComments', () => {
  const since = '2026-01-01T00:10:00Z'

  test('keeps plan comments from the bot after the head commit was planned, in order', () => {
    const comments = [
      {
        author: BOT,
        createdAt: '2026-01-01T00:12:00Z',
        body: 'Ran Plan for dir: `b` workspace: `default`',
      },
      {
        author: BOT,
        createdAt: '2026-01-01T00:11:00Z',
        body: 'Ran Plan for dir: `a` workspace: `default`',
      },
      {
        author: BOT,
        createdAt: '2026-01-01T00:05:00Z',
        body: 'Ran Plan for dir: `old` workspace: `default`',
      },
      {
        author: 'someone',
        createdAt: '2026-01-01T00:13:00Z',
        body: 'Ran Plan for dir: `fake` workspace: `default`',
      },
      {
        author: BOT,
        createdAt: '2026-01-01T00:14:00Z',
        body: 'Ran Apply for dir: `a` workspace: `default`',
      },
    ]
    expect(selectPlanComments(comments, { author: BOT, since })).toStrictEqual([
      'Ran Plan for dir: `a` workspace: `default`',
      'Ran Plan for dir: `b` workspace: `default`',
    ])
  })

  test('joins continued output to the previous comment', () => {
    const comments = [
      {
        author: BOT,
        createdAt: '2026-01-01T00:11:00Z',
        body: 'Ran Plan for dir: `a` workspace: `default`\npart 1',
      },
      {
        author: BOT,
        createdAt: '2026-01-01T00:11:01Z',
        body: 'Continued plan output from previous comment.\npart 2',
      },
    ]
    expect(selectPlanComments(comments, { author: BOT, since })).toStrictEqual([
      'Ran Plan for dir: `a` workspace: `default`\npart 1\nContinued plan output from previous comment.\npart 2',
    ])
  })

  test('drops continued output whose head comment is older than since', () => {
    const comments = [
      {
        author: BOT,
        createdAt: '2026-01-01T00:11:00Z',
        body: 'Continued plan output from previous comment.\npart 2',
      },
    ]
    expect(selectPlanComments(comments, { author: BOT, since })).toStrictEqual([])
  })
})

describe('parsePlanComments', () => {
  test('no comments means no plan', () => {
    expect(parsePlanComments([]).state).toBe('none')
  })

  test('zero projects means no plan', () => {
    expect(parsePlanComments(['Ran Plan for 0 projects:\n\n\n']).state).toBe('none')
  })

  test('single project with changes', () => {
    const plan = parsePlanComments([singleProject])
    expect(plan.state).toBe('changes')
    expect(plan.projects).toStrictEqual([
      {
        project: 'dir: infra/app workspace: default',
        state: 'changes',
        summary: 'Plan: 2 to add, 1 to change, 2 to destroy.',
        resources: [
          { address: 'aws_s3_bucket.logs', action: 'create' },
          { address: 'aws_iam_role.app', action: 'update' },
          { address: 'aws_instance.old', action: 'delete' },
          { address: 'module.db.aws_db_instance.this["primary"]', action: 'replace' },
        ],
      },
    ])
  })

  test('multiple projects: the table of contents is not a section', () => {
    const plan = parsePlanComments([multiProject])
    expect(plan.state).toBe('failed')
    expect(plan.projects.map(p => [p.project, p.state])).toStrictEqual([
      ['dir: infra/a workspace: default', 'no-changes'],
      ['dir: infra/b workspace: default', 'failed'],
    ])
  })

  test('a later plan of the same project overrides an earlier failure', () => {
    const retried = 'Ran Plan for dir: `infra/b` workspace: `default`\n```diff\nNo changes.\n```'
    const plan = parsePlanComments([multiProject, retried])
    expect(plan.state).toBe('no-changes')
    expect(plan.projects.find(p => p.project.includes('infra/b'))?.state).toBe('no-changes')
  })

  test('a command-level failure is cleared by a later plan', () => {
    const failed = '**Plan Failed**: This project is currently locked by #1'
    expect(parsePlanComments([failed]).state).toBe('failed')
    expect(parsePlanComments([failed]).errors).toStrictEqual([failed])
    expect(parsePlanComments([failed, singleProject]).state).toBe('changes')
  })

  test('named projects', () => {
    const plan = parsePlanComments([
      'Ran Plan for project: `app` dir: `.` workspace: `prod`\n```diff\nNo changes.\n```',
    ])
    expect(plan.projects[0]?.project).toBe('project: app dir: . workspace: prod')
  })

  test('unrecognized format is reported as unknown', () => {
    expect(parsePlanComments(['Ran Plan for something new']).state).toBe('unknown')
    expect(parsePlanComments(['Ran Plan for dir: `a` workspace: `default`\n(empty)']).state).toBe(
      'unknown'
    )
  })

  test('resources are deduplicated across projects', () => {
    const a =
      'Ran Plan for dir: `a` workspace: `default`\n  # aws_s3_bucket.x will be created\nPlan: 1 to add, 0 to change, 0 to destroy.'
    const b =
      'Ran Plan for dir: `b` workspace: `default`\n  # aws_s3_bucket.x will be created\nPlan: 1 to add, 0 to change, 0 to destroy.'
    expect(parsePlanComments([a, b]).resources).toStrictEqual([
      { address: 'aws_s3_bucket.x', action: 'create' },
    ])
  })
})
