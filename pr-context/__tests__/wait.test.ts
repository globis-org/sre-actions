import { describe, expect, test } from 'vitest'
import { summarizeStatus, waitForStatus, type StatusRecord } from '../src/wait'

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

function clock() {
  let now = 0
  return { now: () => now, sleep: async (ms: number) => void (now += ms) }
}

describe('waitForStatus', () => {
  test('waits until the status settles', async () => {
    const responses = [
      [],
      [status('pending', '2026-01-01T00:01:00Z')],
      [status('failure', '2026-01-01T00:02:00Z'), status('pending', '2026-01-01T00:01:00Z')],
    ]
    let call = 0
    const result = await waitForStatus({
      fetchStatuses: async () => responses[Math.min(call++, responses.length - 1)] ?? [],
      context: CONTEXT,
      maxWaitMs: 600_000,
      startTimeoutMs: 120_000,
      pollMs: 10_000,
      ...clock(),
    })
    expect(result.kind).toBe('settled')
    expect(call).toBe(3)
  })

  test('gives up early when the status never appears', async () => {
    const c = clock()
    const result = await waitForStatus({
      fetchStatuses: async () => [],
      context: CONTEXT,
      maxWaitMs: 600_000,
      startTimeoutMs: 120_000,
      pollMs: 10_000,
      ...c,
    })
    expect(result.kind).toBe('missing')
    expect(c.now()).toBe(120_000)
  })

  test('times out while pending', async () => {
    const c = clock()
    const result = await waitForStatus({
      fetchStatuses: async () => [status('pending', '2026-01-01T00:01:00Z')],
      context: CONTEXT,
      maxWaitMs: 600_000,
      startTimeoutMs: 120_000,
      pollMs: 10_000,
      ...c,
    })
    expect(result.kind).toBe('pending')
    expect(c.now()).toBe(600_000)
  })

  test('max-wait-time 0 checks once', async () => {
    let call = 0
    const result = await waitForStatus({
      fetchStatuses: async () => {
        call++
        return [status('pending', '2026-01-01T00:01:00Z')]
      },
      context: CONTEXT,
      maxWaitMs: 0,
      startTimeoutMs: 120_000,
      pollMs: 10_000,
      ...clock(),
    })
    expect(result.kind).toBe('pending')
    expect(call).toBe(1)
  })
})
