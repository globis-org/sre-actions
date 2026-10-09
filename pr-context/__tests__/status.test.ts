import { describe, expect, test } from 'vitest'
import { summarizeStatus, type StatusRecord } from '../src/status'

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
