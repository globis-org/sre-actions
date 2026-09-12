export type StatusRecord = {
  context: string
  state: string
  target_url: string | null
  description: string | null
}

export type WorkspaceStatus =
  | { kind: 'pending'; runId: string | null; runUrl: string | null; description: string }
  | { kind: 'untriggered'; description: string }
  | { kind: 'finished'; runId: string; runUrl: string; description: string }
  | { kind: 'errored'; runId: string | null; runUrl: string | null; description: string }
  | { kind: 'missing' }

export const DEFAULT_STATUS_PREFIX = 'Terraform Cloud/'

// HCP Terraform が PR の head commit に付ける commit status の context 名
export function contextName(
  organization: string,
  workspace: string,
  prefix: string = DEFAULT_STATUS_PREFIX
): string {
  return `${prefix}${organization}/${workspace}`
}

// run URL (https://app.terraform.io/app/<org>/<ws>/runs/run-xxx) から run ID を取り出す
export function parseRunId(url: string | null): string | null {
  if (url === null) {
    return null
  }
  const match = /\/runs\/(run-[A-Za-z0-9]+)/.exec(url)
  return match?.[1] ?? null
}

export function classifyStatus(status: StatusRecord): WorkspaceStatus {
  const runId = parseRunId(status.target_url)
  const runUrl = status.target_url
  const description = status.description ?? ''
  switch (status.state) {
    case 'pending':
      return { kind: 'pending', runId, runUrl, description }
    case 'success':
      // trigger されなかった workspace は success だが run へのリンクを持たない
      // ("Run not triggered: Terraform working directories did not change.")
      if (runId === null || runUrl === null) {
        return { kind: 'untriggered', description }
      }
      return { kind: 'finished', runId, runUrl, description }
    default:
      // failure / error
      return { kind: 'errored', runId, runUrl, description }
  }
}

// Status API は新しい順に返すので、context ごとに最初に現れたものが最新
export function latestByContext(statuses: StatusRecord[]): Map<string, StatusRecord> {
  const latest = new Map<string, StatusRecord>()
  for (const status of statuses) {
    if (!latest.has(status.context)) {
      latest.set(status.context, status)
    }
  }
  return latest
}

export type WaitResult = {
  statuses: Map<string, WorkspaceStatus>
  timedOut: boolean
  // 最後のポーリングで commit に付いていた全 context (期待セット外の workspace の検出に使う)
  observedContexts: string[]
}

export async function waitForStatuses(params: {
  fetchStatuses: () => Promise<StatusRecord[]>
  expectedContexts: string[]
  maxWaitMs: number
  pollMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onPoll?: (statuses: Map<string, WorkspaceStatus>) => void
}): Promise<WaitResult> {
  const sleep = params.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = params.now ?? (() => Date.now())
  const startedAt = now()

  for (;;) {
    const latest = latestByContext(await params.fetchStatuses())
    const statuses = new Map<string, WorkspaceStatus>()
    for (const context of params.expectedContexts) {
      const record = latest.get(context)
      statuses.set(context, record === undefined ? { kind: 'missing' } : classifyStatus(record))
    }
    params.onPoll?.(statuses)

    const unsettled = [...statuses.values()].some(
      status => status.kind === 'pending' || status.kind === 'missing'
    )
    const observedContexts = [...latest.keys()]
    if (!unsettled) {
      return { statuses, timedOut: false, observedContexts }
    }
    if (now() - startedAt >= params.maxWaitMs) {
      return { statuses, timedOut: true, observedContexts }
    }
    await sleep(params.pollMs)
  }
}
