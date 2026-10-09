import { describe, expect, test } from 'vitest'
import { disabledPlan, overallState, renderPlanSummary, type PlanResult } from '../src/plan'

const base: PlanResult = {
  provider: 'atlantis',
  state: 'changes',
  projects: [],
  resources: [],
  errors: [],
}

describe('overallState', () => {
  test('failure wins over everything', () => {
    expect(
      overallState(
        [
          { project: 'a', state: 'changes', summary: null, resources: [] },
          { project: 'b', state: 'failed', summary: null, resources: [] },
        ],
        []
      )
    ).toBe('failed')
    expect(overallState([], ['locked'])).toBe('failed')
  })

  test('unknown wins over changes', () => {
    expect(
      overallState(
        [
          { project: 'a', state: 'changes', summary: null, resources: [] },
          { project: 'b', state: 'unknown', summary: null, resources: [] },
        ],
        []
      )
    ).toBe('unknown')
  })

  test('no projects is unknown', () => {
    expect(overallState([], [])).toBe('unknown')
  })
})

describe('renderPlanSummary', () => {
  test('disabled provider', () => {
    expect(renderPlanSummary(disabledPlan())).toBe('plan: 対象外\ndestroy / replace: 対象外\n')
  })

  test('lists destructive changes and every resource', () => {
    const summary = renderPlanSummary({
      ...base,
      projects: [
        {
          project: 'dir: a workspace: default',
          state: 'changes',
          summary: 'Plan: 1 to add, 0 to change, 1 to destroy.',
          resources: [],
        },
      ],
      resources: [
        { address: 'aws_s3_bucket.new', action: 'create' },
        { address: 'aws_s3_bucket.old', action: 'delete' },
        { address: 'aws_s3_bucket.c', action: 'move', previousAddress: 'aws_s3_bucket.b' },
      ],
    })
    expect(summary).toBe(
      [
        'plan: 変更あり',
        'destroy / replace: `aws_s3_bucket.old` (delete)',
        '',
        '| project | 状態 | Plan 行 |',
        '|---|---|---|',
        '| dir: a workspace: default | 変更あり | Plan: 1 to add, 0 to change, 1 to destroy. |',
        '',
        '変更リソース一覧（3 件）:',
        '- `aws_s3_bucket.new` create',
        '- `aws_s3_bucket.old` delete',
        '- `aws_s3_bucket.c` move (moved from `aws_s3_bucket.b`)',
        '',
      ].join('\n')
    )
  })

  test('destroy / replace is unknown when the plan failed', () => {
    const summary = renderPlanSummary({
      ...base,
      state: 'failed',
      projects: [
        { project: 'dir: b workspace: default', state: 'failed', summary: null, resources: [] },
      ],
    })
    expect(summary).toContain('plan: plan 失敗（dir: b workspace: default）')
    expect(summary).toContain('destroy / replace: 不明（plan 失敗（dir: b workspace: default））')
    expect(summary).toContain('- （空）')
  })

  test('no projects is not a warning', () => {
    const summary = renderPlanSummary({ ...base, state: 'no-projects' })
    expect(summary).toContain('plan: plan 対象 project なし')
    expect(summary).toContain('destroy / replace: なし')
  })

  test('no destructive changes', () => {
    expect(renderPlanSummary({ ...base, state: 'no-changes' })).toContain('destroy / replace: なし')
  })
})
