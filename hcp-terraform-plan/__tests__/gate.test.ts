import { describe, expect, test } from 'vitest'
import {
  DESCRIPTION_MAX_LENGTH,
  evaluateGate,
  filterApproversWithWriteAccess,
  listHumanApprovers,
  truncateDescription,
} from '../src/gate'
import type { WorkspaceResult } from '../src/render'

function result(workspace: string, overrides: Partial<WorkspaceResult> = {}): WorkspaceResult {
  return {
    workspace,
    kind: 'finished',
    runId: 'run-1',
    runUrl: 'https://app.terraform.io/app/my-org/infra-app/runs/run-1',
    description: '',
    plan: {
      status: 'finished',
      hasChanges: false,
      additions: 0,
      changes: 0,
      destructions: 0,
      imports: 0,
      logReadUrl: null,
    },
    log: null,
    ...overrides,
  }
}

function withChanges(workspace: string): WorkspaceResult {
  return result(workspace, {
    plan: {
      status: 'finished',
      hasChanges: true,
      additions: 1,
      changes: 0,
      destructions: 0,
      imports: 0,
      logReadUrl: null,
    },
  })
}

const untriggered = (workspace: string): WorkspaceResult =>
  result(workspace, { kind: 'untriggered', runId: null, runUrl: null, plan: null })

describe('listHumanApprovers', () => {
  const human = { login: 'alice', type: 'User' }
  const bot = { login: 'renovate-approve[bot]', type: 'Bot' }

  test('returns users whose latest review is APPROVED, excluding bots', () => {
    expect(
      listHumanApprovers([
        { state: 'APPROVED', user: bot },
        { state: 'APPROVED', user: human },
      ])
    ).toStrictEqual(['alice'])
  })

  test('a later CHANGES_REQUESTED or DISMISSED revokes the approval, COMMENTED does not', () => {
    expect(
      listHumanApprovers([
        { state: 'APPROVED', user: human },
        { state: 'COMMENTED', user: human },
      ])
    ).toStrictEqual(['alice'])
    expect(
      listHumanApprovers([
        { state: 'APPROVED', user: human },
        { state: 'DISMISSED', user: human },
      ])
    ).toStrictEqual([])
    expect(
      listHumanApprovers([
        { state: 'CHANGES_REQUESTED', user: human },
        { state: 'APPROVED', user: human },
      ])
    ).toStrictEqual(['alice'])
  })

  test('ignores reviews without a user', () => {
    expect(listHumanApprovers([{ state: 'APPROVED', user: null }])).toStrictEqual([])
  })
})

describe('filterApproversWithWriteAccess', () => {
  test('keeps admin and write, drops read-only approvers', async () => {
    const permissions: Record<string, string> = {
      alice: 'admin',
      bob: 'write',
      carol: 'read',
      dave: 'none',
    }
    await expect(
      filterApproversWithWriteAccess(['alice', 'bob', 'carol', 'dave'], username =>
        Promise.resolve(permissions[username] ?? 'none')
      )
    ).resolves.toStrictEqual(['alice', 'bob'])
  })

  test('a read-only approval alone leaves the gate pending', async () => {
    const approvers = await filterApproversWithWriteAccess(['carol'], () => Promise.resolve('read'))
    expect(
      evaluateGate([withChanges('a')], { timedOut: false, humanApprovers: approvers }).state
    ).toBe('pending')
  })
})

describe('evaluateGate', () => {
  test('success when no workspace has changes', () => {
    expect(
      evaluateGate([result('a'), untriggered('b')], { timedOut: false, humanApprovers: [] })
    ).toStrictEqual({
      state: 'success',
      description: 'No changes in 1 workspace(s)',
    })
  })

  test('success when nothing was triggered', () => {
    expect(evaluateGate([untriggered('a')], { timedOut: false, humanApprovers: [] }).state).toBe(
      'success'
    )
  })

  test('pending when changes exist and only bots approved', () => {
    const gate = evaluateGate([withChanges('a'), result('b')], {
      timedOut: false,
      humanApprovers: [],
    })
    expect(gate.state).toBe('pending')
    expect(gate.description).toBe('Changes in 1 workspace(s) (a); waiting for a non-bot approval')
  })

  test('success when changes exist and a human approved', () => {
    expect(
      evaluateGate([withChanges('a')], { timedOut: false, humanApprovers: ['alice'] })
    ).toStrictEqual({
      state: 'success',
      description: 'Changes in 1 workspace(s) approved by alice',
    })
  })

  test('failure when a run errored, even if approved', () => {
    const errored = result('a', { kind: 'errored', plan: null })
    expect(
      evaluateGate([errored, withChanges('b')], { timedOut: false, humanApprovers: ['alice'] })
    ).toStrictEqual({
      state: 'failure',
      description: '1 run(s) errored: a',
    })
  })

  test('failure on timeout / missing statuses', () => {
    const missing = result('a', { kind: 'missing', runId: null, runUrl: null, plan: null })
    expect(evaluateGate([missing], { timedOut: true, humanApprovers: [] })).toStrictEqual({
      state: 'failure',
      description: 'Timed out waiting for: a',
    })
  })

  test('failure when statuses exist for workspaces outside the checked set, even with no changes', () => {
    expect(
      evaluateGate([result('a')], {
        timedOut: false,
        humanApprovers: ['alice'],
        unexpectedWorkspaces: ['b'],
      })
    ).toStrictEqual({ state: 'failure', description: 'Workspaces outside the checked set: b' })
  })

  test('failure when a connected workspace has speculative plans disabled', () => {
    expect(
      evaluateGate([result('a')], {
        timedOut: false,
        humanApprovers: [],
        unobservableWorkspaces: ['c'],
      })
    ).toStrictEqual({ state: 'failure', description: 'Speculative plans disabled for: c' })
  })

  test('failure when a finished run has no plan data (fail-closed)', () => {
    expect(
      evaluateGate([result('a', { plan: null })], { timedOut: false, humanApprovers: ['alice'] })
    ).toStrictEqual({
      state: 'failure',
      description: 'Plan unavailable for: a',
    })
  })

  test('keeps the description within the commit status limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => withChanges(`infra-app-workspace-${i}`))
    const gate = evaluateGate(many, { timedOut: false, humanApprovers: [] })
    expect(gate.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH)
    expect(gate.description.endsWith('…')).toBe(true)
  })
})

describe('truncateDescription', () => {
  test('leaves short descriptions untouched', () => {
    expect(truncateDescription('short')).toBe('short')
  })
})
