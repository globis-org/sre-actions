import { describe, expect, test } from 'vitest'
import {
  classifyStatus,
  contextName,
  latestByContext,
  parseRunId,
  waitForStatuses,
  type StatusRecord,
} from '../src/statuses'

const RUN_URL = 'https://app.terraform.io/app/my-org/infra-app-prod/runs/run-AbC123xyz'

describe('contextName', () => {
  test('uses the default prefix and accepts a custom one', () => {
    expect(contextName('my-org', 'infra-app-prod')).toBe('Terraform Cloud/my-org/infra-app-prod')
    expect(contextName('my-org', 'infra-app-prod', 'HCP Terraform/')).toBe(
      'HCP Terraform/my-org/infra-app-prod'
    )
  })
})

describe('parseRunId', () => {
  test('extracts run ID from the run URL', () => {
    expect(parseRunId(RUN_URL)).toBe('run-AbC123xyz')
  })
  test('returns null for null or unrelated URLs', () => {
    expect(parseRunId(null)).toBeNull()
    expect(parseRunId('https://example.com/')).toBeNull()
  })
})

describe('classifyStatus', () => {
  const base = { context: contextName('my-org', 'infra-app-prod') }

  test('success with run URL is finished', () => {
    expect(
      classifyStatus({
        ...base,
        state: 'success',
        target_url: RUN_URL,
        description: 'Terraform plan: 1 to add, 0 to change, 0 to destroy.',
      })
    ).toStrictEqual({
      kind: 'finished',
      runId: 'run-AbC123xyz',
      runUrl: RUN_URL,
      description: 'Terraform plan: 1 to add, 0 to change, 0 to destroy.',
    })
  })
  test('success without run URL is untriggered', () => {
    expect(
      classifyStatus({
        ...base,
        state: 'success',
        target_url: null,
        description: 'Run not triggered: Terraform working directories did not change.',
      })
    ).toStrictEqual({
      kind: 'untriggered',
      description: 'Run not triggered: Terraform working directories did not change.',
    })
  })
  test('failure is errored and keeps the run link', () => {
    expect(
      classifyStatus({
        ...base,
        state: 'failure',
        target_url: RUN_URL,
        description: 'Terraform plan errored',
      })
    ).toStrictEqual({
      kind: 'errored',
      runId: 'run-AbC123xyz',
      runUrl: RUN_URL,
      description: 'Terraform plan errored',
    })
  })
  test('pending is pending', () => {
    expect(
      classifyStatus({
        ...base,
        state: 'pending',
        target_url: RUN_URL,
        description: 'Terraform plan pending',
      }).kind
    ).toBe('pending')
  })
})

describe('latestByContext', () => {
  test('keeps the first (newest) record per context', () => {
    const newest: StatusRecord = {
      context: 'a',
      state: 'success',
      target_url: RUN_URL,
      description: 'new',
    }
    const older: StatusRecord = {
      context: 'a',
      state: 'pending',
      target_url: null,
      description: 'old',
    }
    expect(latestByContext([newest, older]).get('a')).toBe(newest)
  })
})

describe('waitForStatuses', () => {
  const ctxA = contextName('my-org', 'infra-app-prod')
  const ctxB = contextName('my-org', 'infra-app-stg')

  test('polls until all expected contexts are settled', async () => {
    const polls: StatusRecord[][] = [
      [],
      [{ context: ctxA, state: 'pending', target_url: RUN_URL, description: '' }],
      [
        { context: ctxA, state: 'success', target_url: RUN_URL, description: 'ok' },
        { context: ctxB, state: 'success', target_url: null, description: 'Run not triggered' },
      ],
    ]
    let calls = 0
    const sleeps: number[] = []
    const result = await waitForStatuses({
      fetchStatuses: () => Promise.resolve(polls[Math.min(calls++, polls.length - 1)] ?? []),
      expectedContexts: [ctxA, ctxB],
      maxWaitMs: 60_000,
      pollMs: 10,
      sleep: ms => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      now: () => 0,
    })
    expect(result.timedOut).toBe(false)
    expect(calls).toBe(3)
    expect(sleeps).toStrictEqual([10, 10])
    expect(result.statuses.get(ctxA)?.kind).toBe('finished')
    expect(result.statuses.get(ctxB)?.kind).toBe('untriggered')
    expect(result.observedContexts.toSorted()).toStrictEqual([ctxA, ctxB].toSorted())
  })

  test('reports contexts that were not expected', async () => {
    const ctxOther = contextName('my-org', 'infra-app-unlisted')
    const result = await waitForStatuses({
      fetchStatuses: () =>
        Promise.resolve([
          { context: ctxA, state: 'success', target_url: RUN_URL, description: 'ok' },
          { context: ctxOther, state: 'success', target_url: RUN_URL, description: 'ok' },
          { context: 'ci/test', state: 'success', target_url: null, description: '' },
        ]),
      expectedContexts: [ctxA],
      maxWaitMs: 1000,
      pollMs: 10,
      now: () => 0,
    })
    expect(result.timedOut).toBe(false)
    expect(result.observedContexts).toContain(ctxOther)
    expect(result.observedContexts).toContain('ci/test')
    expect(result.statuses.has(ctxOther)).toBe(false)
  })

  test('times out and reports missing / pending contexts', async () => {
    let time = 0
    const result = await waitForStatuses({
      fetchStatuses: () =>
        Promise.resolve([{ context: ctxA, state: 'pending', target_url: null, description: '' }]),
      expectedContexts: [ctxA, ctxB],
      maxWaitMs: 100,
      pollMs: 50,
      sleep: () => {
        time += 50
        return Promise.resolve()
      },
      now: () => time,
    })
    expect(result.timedOut).toBe(true)
    expect(result.statuses.get(ctxA)?.kind).toBe('pending')
    expect(result.statuses.get(ctxB)?.kind).toBe('missing')
  })
})
