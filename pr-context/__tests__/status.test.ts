import { describe, expect, test } from 'vitest'
import { latestProjectStatuses, summarizeStatus, type StatusRecord } from '../src/status'

const CONTEXT = 'atlantis/plan'

function status(state: string, createdAt: string, context = CONTEXT): StatusRecord {
  return { context, state, description: `${state} description`, created_at: createdAt }
}

describe('summarizeStatus', () => {
  test('missing', () => {
    expect(
      summarizeStatus([status('success', '2026-01-01T00:00:00Z', 'other')], CONTEXT)
    ).toStrictEqual({
      kind: 'missing',
    })
  })

  test('uses the latest state and the earliest time', () => {
    expect(
      summarizeStatus(
        [status('success', '2026-01-01T00:02:00Z'), status('pending', '2026-01-01T00:01:00Z')],
        CONTEXT
      )
    ).toStrictEqual({
      kind: 'settled',
      state: 'success',
      firstCreatedAt: '2026-01-01T00:01:00Z',
      description: 'success description',
    })
  })
})

describe('latestProjectStatuses', () => {
  test('keeps the latest status of each project and ignores the aggregate one', () => {
    expect(
      latestProjectStatuses(
        [
          status('success', '2026-01-01T00:03:00Z', 'atlantis/plan'),
          {
            ...status('success', '2026-01-01T00:02:00Z', 'atlantis/plan: infra/a/default'),
            description: 'No changes.',
          },
          status('pending', '2026-01-01T00:01:00Z', 'atlantis/plan: infra/a/default'),
          status('failure', '2026-01-01T00:01:00Z', 'atlantis/plan: app'),
          status('success', '2026-01-01T00:01:00Z', 'atlantis/apply: infra/a/default'),
        ],
        CONTEXT
      )
    ).toStrictEqual(
      new Map([
        ['infra/a/default', { state: 'success', description: 'No changes.' }],
        ['app', { state: 'failure', description: 'failure description' }],
      ])
    )
  })
})
