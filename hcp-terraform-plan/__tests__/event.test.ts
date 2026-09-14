import { describe, expect, test } from 'vitest'
import { decideEvent } from '../src/event'

const pullRequest = { number: 42, head: { sha: 'abc123' }, base: { ref: 'main' } }

describe('decideEvent', () => {
  test('pull_request is evaluated', () => {
    expect(
      decideEvent('pull_request', { action: 'synchronize', pull_request: pullRequest })
    ).toStrictEqual({
      kind: 'evaluate',
      headSha: 'abc123',
      baseRef: 'main',
      pullRequestNumber: 42,
    })
  })

  test.each([
    ['submitted', 'approved'],
    ['submitted', 'changes_requested'],
    ['dismissed', 'dismissed'],
  ])('pull_request_review %s/%s is evaluated', (action, state) => {
    expect(
      decideEvent('pull_request_review', { action, review: { state }, pull_request: pullRequest })
        .kind
    ).toBe('evaluate')
  })

  test.each([
    ['submitted', 'commented'],
    ['edited', 'approved'],
    ['edited', 'commented'],
  ])(
    'pull_request_review %s/%s is skipped because it does not change approval',
    (action, state) => {
      const decision = decideEvent('pull_request_review', {
        action,
        review: { state },
        pull_request: pullRequest,
      })
      expect(decision.kind).toBe('skip')
      if (decision.kind === 'skip') {
        expect(decision.reason).toContain(action)
      }
    }
  )

  test('merge_group reports the merge group head sha', () => {
    expect(decideEvent('merge_group', { merge_group: { head_sha: 'mg123' } })).toStrictEqual({
      kind: 'merge-group',
      headSha: 'mg123',
    })
  })

  test('other events are unsupported with a helpful reason', () => {
    const decision = decideEvent('push', {})
    expect(decision.kind).toBe('unsupported')
    if (decision.kind === 'unsupported') {
      expect(decision.reason).toContain('pull_request, pull_request_review, merge_group')
    }
  })

  test('pull_request without payload is unsupported', () => {
    expect(decideEvent('pull_request', {}).kind).toBe('unsupported')
  })
})
