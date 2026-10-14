import { describe, expect, test } from 'vitest'
import { evaluate, fetchStatuses, matches, parseContextNames, run } from '../wait.cjs'

type Status = { context: string; state: string; description: string | null }

const status = (context: string, state: string, description = ''): Status => ({
  context,
  state,
  description,
})

const project = (name: string, state: string): Status => status(`atlantis/plan: ${name}`, state)

describe('parseContextNames', () => {
  test('splits by commas and newlines', () => {
    expect(parseContextNames('atlantis/plan*, ci/test\n\n  build/production \r\n')).toStrictEqual([
      'atlantis/plan*',
      'ci/test',
      'build/production',
    ])
  })
})

describe('matches', () => {
  test.each([
    ['atlantis/plan*', 'atlantis/plan', true],
    ['atlantis/plan*', 'atlantis/plan: infra/app/stg/default', true],
    ['atlantis/plan*', 'atlantis/apply', false],
    ['atlantis/plan', 'atlantis/plan', true],
    ['atlantis/plan', 'atlantis/plan: infra/app/stg/default', false],
  ])('%s with %s', (pattern, context, expected) => {
    expect(matches(pattern, context)).toBe(expected)
  })
})

describe('evaluate', () => {
  test('a failure does not complete the wait while a project is pending', () => {
    const result = evaluate(
      ['atlantis/plan*'],
      [status('atlantis/plan', 'failure'), project('a/default', 'pending')]
    )
    expect(result.complete).toBe(false)
    expect(result.status).toBe('pending')
    expect(result.pending.map((s: Status) => s.context)).toStrictEqual(['atlantis/plan: a/default'])
  })

  test('all success (including no changes) completes with success', () => {
    const result = evaluate(
      ['atlantis/plan*'],
      [
        status('atlantis/plan', 'success', '2/2 projects planned successfully.'),
        project('a/default', 'success'),
        project('b/default', 'success'),
      ]
    )
    expect(result).toMatchObject({ complete: true, status: 'success', missing: [] })
    expect(result.succeeded).toHaveLength(3)
  })

  test('a failure completes with failure once nothing is pending', () => {
    const result = evaluate(
      ['atlantis/plan*'],
      [
        status('atlantis/plan', 'failure'),
        project('a/default', 'success'),
        project('b/default', 'success'),
      ]
    )
    expect(result).toMatchObject({ complete: true, status: 'failure' })
    expect(result.failed.map((s: Status) => s.context)).toStrictEqual(['atlantis/plan'])
  })

  test('error counts as failure', () => {
    expect(evaluate(['ci/test'], [status('ci/test', 'error')]).status).toBe('failure')
  })

  test('a prefix with no match is not complete', () => {
    const result = evaluate(['atlantis/plan*'], [status('ci/test', 'success')])
    expect(result).toMatchObject({ complete: false, missing: ['atlantis/plan*'] })
  })

  test('a missing exact name is not complete', () => {
    const result = evaluate(['atlantis/plan', 'ci/test'], [status('atlantis/plan', 'success')])
    expect(result).toMatchObject({ complete: false, missing: ['ci/test'] })
  })

  test('statuses that do not match are ignored', () => {
    const result = evaluate(
      ['atlantis/plan'],
      [status('atlantis/plan', 'success'), project('a/default', 'pending')]
    )
    expect(result).toMatchObject({ complete: true, status: 'success' })
  })

  test('the first status of each context is the latest', () => {
    const result = evaluate(
      ['ci/test'],
      [status('ci/test', 'success'), status('ci/test', 'pending')]
    )
    expect(result).toMatchObject({ complete: true, status: 'success' })
  })
})

// combined status の API を模す。statuses は context ごとに最新の 1 件
const fakeGithub = (all: Status[]) => {
  const pages: number[] = []
  return {
    pages,
    rest: {
      repos: {
        getCombinedStatusForRef: async ({ per_page, page }: { per_page: number; page: number }) => {
          pages.push(page)
          return {
            data: {
              state: 'failure',
              total_count: all.length,
              statuses: all.slice((page - 1) * per_page, page * per_page),
            },
          }
        },
      },
    },
  }
}

describe('fetchStatuses', () => {
  const params = { owner: 'org', repo: 'repo', ref: 'abc' }

  test('pages through more than 100 contexts and judges by the latest states', async () => {
    const projects = Array.from({ length: 120 }, (_, i) => project(`p${i}/default`, 'success'))
    const github = fakeGithub([status('atlantis/plan', 'success'), ...projects])
    const statuses = await fetchStatuses(github, params)
    expect(statuses).toHaveLength(121)
    expect(github.pages).toStrictEqual([1, 2])
    expect(evaluate(['atlantis/plan*'], statuses)).toMatchObject({
      complete: true,
      status: 'success',
    })
  })

  test('a pending context on a later page keeps the wait going', async () => {
    const projects = Array.from({ length: 100 }, (_, i) => project(`p${i}/default`, 'success'))
    const github = fakeGithub([
      status('atlantis/plan', 'failure'),
      ...projects,
      project('z/default', 'pending'),
    ])
    const statuses = await fetchStatuses(github, params)
    expect(evaluate(['atlantis/plan*'], statuses).complete).toBe(false)
  })

  test('stops on an empty page', async () => {
    const github = fakeGithub([])
    expect(await fetchStatuses(github, params)).toStrictEqual([])
    expect(github.pages).toStrictEqual([1])
  })
})

// 呼ぶたびに polls の次の要素を返す。尽きたら最後の要素を返し続ける
const setup = (polls: Status[][], env: Record<string, string> = {}) => {
  let calls = 0
  let clock = 0
  const outputs: Record<string, string> = {}
  const github = {
    rest: {
      repos: {
        getCombinedStatusForRef: async () => {
          const statuses = polls[Math.min(calls++, polls.length - 1)] ?? []
          return { data: { total_count: statuses.length, statuses } }
        },
      },
    },
  }
  const args = {
    github,
    context: {
      repo: { owner: 'org', repo: 'repo' },
      payload: { pull_request: { head: { sha: 'abc' } } },
    },
    core: {
      info: () => {},
      setOutput: (name: string, value: string) => {
        outputs[name] = value
      },
    },
    env: {
      CONTEXT_NAMES: 'atlantis/plan*',
      MAX_WAIT_TIME: '60',
      POLL_INTERVAL: '10',
      FAIL_ON_TIMEOUT: 'true',
      ...env,
    },
    sleep: async (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
  return { args, outputs, calls: () => calls }
}

describe('run', () => {
  test('keeps polling past a failure until nothing is pending', async () => {
    const { args, outputs, calls } = setup([
      [],
      [status('atlantis/plan', 'failure'), project('a/default', 'pending')],
      [status('atlantis/plan', 'success'), project('a/default', 'success')],
    ])
    await run(args)
    expect(calls()).toBe(3)
    expect(outputs).toStrictEqual({
      status: 'success',
      'timed-out': 'false',
      'pending-count': '0',
      'failed-count': '0',
      'succeeded-count': '2',
    })
  })

  test('fails on timeout with status pending', async () => {
    const { args, outputs, calls } = setup([[project('a/default', 'pending')]])
    await expect(run(args)).rejects.toThrow('Timeout waiting for commit statuses')
    expect(calls()).toBe(6)
    expect(outputs).toMatchObject({ status: 'pending', 'timed-out': 'true', 'pending-count': '1' })
  })

  test('does not fail on timeout when fail-on-timeout is false', async () => {
    const { args, outputs } = setup([[project('a/default', 'pending')]], {
      FAIL_ON_TIMEOUT: 'false',
    })
    await run(args)
    expect(outputs).toMatchObject({ status: 'pending', 'timed-out': 'true' })
  })

  test.each([
    [{ MAX_WAIT_TIME: 'abc' }, 'MAX_WAIT_TIME must be a non-negative number'],
    [{ POLL_INTERVAL: '' }, 'POLL_INTERVAL must be a non-negative number'],
    [{ CONTEXT_NAMES: ' , ' }, 'context-names is empty'],
  ])('rejects invalid inputs %o', async (env, message) => {
    await expect(run(setup([], env).args)).rejects.toThrow(message)
  })

  test('rejects events other than pull_request', async () => {
    const { args } = setup([])
    await expect(run({ ...args, context: { ...args.context, payload: {} } })).rejects.toThrow(
      'pull_request'
    )
  })
})
