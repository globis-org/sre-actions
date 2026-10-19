import { describe, expect, test } from 'vitest'
import type { Plan } from '../src/plan'
import { destroyOrReplace, renderLatestPlans, renderSummary } from '../src/summary'

const plan: Plan = {
  state: 'changes',
  projects: [
    {
      project: 'infra/prod/default',
      state: 'changes',
      status: 'Plan: 1 to add, 0 to change, 1 to destroy.',
      resources: [],
    },
  ],
  resources: [
    { address: 'aws_s3_bucket.new', action: 'create', project: 'infra/prod/default' },
    { address: 'aws_s3_bucket.old', action: 'delete', project: 'infra/prod/default' },
    {
      address: 'aws_s3_bucket.c',
      action: 'move',
      previousAddress: 'aws_s3_bucket.b',
      project: 'infra/prod/default',
    },
  ],
}

describe('renderSummary', () => {
  test('reasons with HTML or pipes do not break the table', () => {
    const summary = renderSummary({
      state: 'failed',
      projects: [
        {
          project: 'infra/prod/default',
          state: 'failed',
          status: 'Plan failed.',
          reason: '<details><summary>Show Output</summary> a | b',
          resources: [],
        },
      ],
      resources: [],
    })
    expect(summary).toContain(
      '| infra/prod/default | 失敗 | Plan failed. | &lt;details&gt;&lt;summary&gt;Show Output&lt;/summary&gt; a \\| b |'
    )
  })

  test('lists destructive changes, projects and every resource', () => {
    expect(renderSummary(plan)).toBe(
      [
        'plan: 変更あり',
        'destroy / replace: `aws_s3_bucket.old` (delete, infra/prod/default)',
        '',
        '| project | 状態 | status | 理由 |',
        '|---|---|---|---|',
        '| infra/prod/default | 変更あり | Plan: 1 to add, 0 to change, 1 to destroy. |  |',
        '',
        '変更リソース一覧（3 件）:',
        '- infra/prod/default: `aws_s3_bucket.new` create',
        '- infra/prod/default: `aws_s3_bucket.old` delete',
        '- infra/prod/default: `aws_s3_bucket.c` move (moved from `aws_s3_bucket.b`)',
        '',
      ].join('\n')
    )
  })

  test('states without projects', () => {
    expect(renderSummary({ state: 'no-projects', projects: [], resources: [] })).toBe(
      'plan: plan 対象 project なし\ndestroy / replace: なし\n'
    )
    expect(renderSummary({ state: 'pending', projects: [], resources: [] })).toBe(
      'plan: plan 未完了\ndestroy / replace: 不明（plan 未完了）\n'
    )
  })
})

describe('destroyOrReplace', () => {
  test.each([
    [plan, 'true'],
    [{ ...plan, resources: [{ address: 'a', action: 'update' as const, project: 'p' }] }, 'false'],
    [{ ...plan, state: 'incomplete' as const, resources: [] }, 'unknown'],
    [{ ...plan, state: 'failed' as const, resources: [] }, 'unknown'],
    [{ ...plan, state: 'none' as const, resources: [] }, 'unknown'],
  ])('%#', (input, expected) => {
    expect(destroyOrReplace(input)).toBe(expected)
  })
})

describe('renderLatestPlans', () => {
  test('one section per project, sorted, without trailing separators', () => {
    expect(
      renderLatestPlans(
        new Map([
          ['infra/stg/default', '```diff\nNo changes.\n```\n\n---\n'],
          ['infra/prod/default', '\n```diff\nPlan: 1 to add, 0 to change, 0 to destroy.\n```\n'],
        ])
      )
    ).toBe(
      [
        '## infra/prod/default',
        '',
        '```diff',
        'Plan: 1 to add, 0 to change, 0 to destroy.',
        '```',
        '',
        '## infra/stg/default',
        '',
        '```diff',
        'No changes.',
        '```',
        '',
      ].join('\n')
    )
  })

  test('no sections', () => {
    expect(renderLatestPlans(new Map())).toBe('')
  })
})
