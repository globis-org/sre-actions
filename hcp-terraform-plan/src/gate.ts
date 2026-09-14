import type { WorkspaceResult } from './render'

// GitHub の review オブジェクトのうち判定に必要な項目だけを受け取る
export type Review = {
  state: string
  user: { login: string; type: string } | null
}

export type GateState = 'success' | 'pending' | 'failure'

export type GateResult = {
  state: GateState
  description: string
}

// commit status の description は 140 文字制限
export const DESCRIPTION_MAX_LENGTH = 140

export function truncateDescription(description: string): string {
  return description.length > DESCRIPTION_MAX_LENGTH
    ? `${description.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
    : description
}

// ユーザーごとの最新の review 状態が APPROVED で、かつ bot でない人を approver とする。
// COMMENTED は承認状態を変えないので無視し、CHANGES_REQUESTED や DISMISSED が後にあれば approve は取り消されたとみなす。
// reviews は API が返す時系列順で渡されることを前提とする。
// bot (renovate-approve など) を除くのは、この gate の目的が「bot の approve だけで diff を通さない」ことだから。
export function listHumanApprovers(reviews: Review[]): string[] {
  const latestStateByUser = new Map<string, { state: string; type: string }>()
  for (const review of reviews) {
    if (!review.user || review.state === 'COMMENTED' || review.state === 'PENDING') {
      continue
    }
    latestStateByUser.set(review.user.login, { state: review.state, type: review.user.type })
  }
  return [...latestStateByUser]
    .filter(([, latest]) => latest.state === 'APPROVED' && latest.type !== 'Bot')
    .map(([login]) => login)
}

const names = (items: WorkspaceResult[]): string => items.map(item => item.workspace).join(', ')

// approve を出した人のうち write 権限以上を持つ人だけを残す。
// GitHub の review は read 権限でも出せるが、branch protection が数えるのは write 以上だけなので、それに合わせる。
export async function filterApproversWithWriteAccess(
  approvers: string[],
  getPermission: (username: string) => Promise<string>
): Promise<string[]> {
  const permissions = await Promise.all(
    approvers.map(async approver => [approver, await getPermission(approver)] as const)
  )
  return permissions
    .filter(([, permission]) => permission === 'admin' || permission === 'write')
    .map(([login]) => login)
}

// diff がなければ success、diff があれば人間の approve があるときだけ success、なければ pending。
// run の失敗、plan を取得できない状態、判定対象に入っていない workspace の存在は fail-closed で failure にする。
export function evaluateGate(
  results: WorkspaceResult[],
  options: {
    timedOut: boolean
    humanApprovers: string[]
    // 期待セットに無いのに HCP Terraform の status が付いていた workspace (token のスコープ外や workspaces の指定漏れ)
    unexpectedWorkspaces?: string[]
    // speculative plan が無効で、この gate から diff を確認できない workspace
    unobservableWorkspaces?: string[]
  }
): GateResult {
  const errored = results.filter(result => result.kind === 'errored')
  if (errored.length > 0) {
    return {
      state: 'failure',
      description: truncateDescription(`${errored.length} run(s) errored: ${names(errored)}`),
    }
  }
  const unexpected = options.unexpectedWorkspaces ?? []
  if (unexpected.length > 0) {
    return {
      state: 'failure',
      description: truncateDescription(
        `Workspaces outside the checked set: ${unexpected.join(', ')}`
      ),
    }
  }
  const unobservable = options.unobservableWorkspaces ?? []
  if (unobservable.length > 0) {
    return {
      state: 'failure',
      description: truncateDescription(
        `Speculative plans disabled for: ${unobservable.join(', ')}`
      ),
    }
  }
  const unsettled = results.filter(result => result.kind === 'pending' || result.kind === 'missing')
  if (options.timedOut || unsettled.length > 0) {
    return {
      state: 'failure',
      description: truncateDescription(`Timed out waiting for: ${names(unsettled)}`),
    }
  }
  const unavailable = results.filter(result => result.kind === 'finished' && result.plan === null)
  if (unavailable.length > 0) {
    return {
      state: 'failure',
      description: truncateDescription(`Plan unavailable for: ${names(unavailable)}`),
    }
  }

  const changed = results.filter(result => result.plan?.hasChanges === true)
  const planned = results.filter(result => result.kind === 'finished')
  if (changed.length === 0) {
    return {
      state: 'success',
      description:
        planned.length === 0
          ? 'No workspaces were triggered'
          : `No changes in ${planned.length} workspace(s)`,
    }
  }
  if (options.humanApprovers.length === 0) {
    return {
      state: 'pending',
      description: truncateDescription(
        `Changes in ${changed.length} workspace(s) (${names(changed)}); waiting for a non-bot approval`
      ),
    }
  }
  return {
    state: 'success',
    description: truncateDescription(
      `Changes in ${changed.length} workspace(s) approved by ${options.humanApprovers.join(', ')}`
    ),
  }
}
