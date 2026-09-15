// この action がどのイベントで何をするかを 1 箇所で決める。
//
// - pull_request:        評価する (plan の待機、コメント、gate)
// - pull_request_review: approve / request changes / dismiss のときだけ gate を再評価する。
//                        COMMENTED や本文の編集は approve の状態を変えないので何もしない
// - merge_group:         merge queue の commit には HCP Terraform の speculative plan が走らないため
//                        評価できない。PR 側で評価済みなので gate を success にして queue を止めない
//
// なお「job を起動しない」判断 (コスト削減) は workflow の job レベル `if` にしか書けない。
// ここでの skip は runner 起動後の no-op なので課金は発生する。README の推奨 workflow を参照。

export const SUPPORTED_EVENTS = ['pull_request', 'pull_request_review', 'merge_group'] as const

export type EventDecision =
  | { kind: 'evaluate'; headSha: string; baseRef: string; pullRequestNumber: number }
  | { kind: 'merge-group'; headSha: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'unsupported'; reason: string }

type PullRequestPayload = {
  number: number
  head: { sha: string }
  base: { ref: string }
}

// review が submit されたときに gate の判定を変えうる state
const REVIEW_STATES_AFFECTING_APPROVAL = new Set(['approved', 'changes_requested'])

export function decideEvent(eventName: string, payload: Record<string, unknown>): EventDecision {
  switch (eventName) {
    case 'pull_request': {
      const pullRequest = payload['pull_request'] as PullRequestPayload | undefined
      if (pullRequest === undefined) {
        return { kind: 'unsupported', reason: 'pull_request event without a pull_request payload' }
      }
      return evaluate(pullRequest)
    }
    case 'pull_request_review': {
      const pullRequest = payload['pull_request'] as PullRequestPayload | undefined
      if (pullRequest === undefined) {
        return {
          kind: 'unsupported',
          reason: 'pull_request_review event without a pull_request payload',
        }
      }
      const action = String(payload['action'] ?? '')
      const review = payload['review'] as { state?: string } | undefined
      const state = String(review?.state ?? '').toLowerCase()
      if (
        action === 'dismissed' ||
        (action === 'submitted' && REVIEW_STATES_AFFECTING_APPROVAL.has(state))
      ) {
        return evaluate(pullRequest)
      }
      return {
        kind: 'skip',
        reason: `review ${action}${state === '' ? '' : ` (${state})`} does not change the approval state`,
      }
    }
    case 'merge_group': {
      const mergeGroup = payload['merge_group'] as { head_sha?: string } | undefined
      if (mergeGroup?.head_sha === undefined) {
        return { kind: 'unsupported', reason: 'merge_group event without a head_sha' }
      }
      return { kind: 'merge-group', headSha: mergeGroup.head_sha }
    }
    default:
      return {
        kind: 'unsupported',
        reason: `event "${eventName}" is not supported (supported: ${SUPPORTED_EVENTS.join(', ')})`,
      }
  }
}

function evaluate(pullRequest: PullRequestPayload): EventDecision {
  return {
    kind: 'evaluate',
    headSha: pullRequest.head.sha,
    baseRef: pullRequest.base.ref,
    pullRequestNumber: pullRequest.number,
  }
}
