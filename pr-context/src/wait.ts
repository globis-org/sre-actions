export type StatusRecord = {
  context: string
  state: string
  description: string | null
  created_at: string
}

export type StatusWaitResult =
  | { kind: 'missing' }
  | { kind: 'pending'; firstCreatedAt: string; description: string }
  | { kind: 'settled'; state: string; firstCreatedAt: string; description: string }

// statuses (Status API は新しい順) から context の最新の状態と、最初に付いた時刻を求める。
// 最初の status の時刻は「この commit に対する plan が始まった時刻」で、それより前の plan コメントは
// 古い head に対するものと判断できる (push 時刻を Activity API で取るより権限・形式の前提が少ない)
export function summarizeStatus(statuses: StatusRecord[], context: string): StatusWaitResult {
  const matched = statuses.filter(status => status.context === context)
  const latest = matched[0]
  if (latest === undefined) {
    return { kind: 'missing' }
  }
  const firstCreatedAt = matched
    .map(status => status.created_at)
    .reduce((min, value) => (Date.parse(value) < Date.parse(min) ? value : min))
  const description = latest.description ?? ''
  if (latest.state === 'pending') {
    return { kind: 'pending', firstCreatedAt, description }
  }
  return { kind: 'settled', state: latest.state, firstCreatedAt, description }
}

// status が settled になるまで待つ。startTimeoutMs までに status が付かなければ plan 無しとみなす
// (Atlantis が対象外と判断した PR では status が付かないことがあるため、maxWaitMs まで待たない)
export async function waitForStatus(params: {
  fetchStatuses: () => Promise<StatusRecord[]>
  context: string
  maxWaitMs: number
  startTimeoutMs: number
  pollMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onPoll?: (result: StatusWaitResult) => void
}): Promise<StatusWaitResult> {
  const sleep = params.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = params.now ?? (() => Date.now())
  const startedAt = now()

  for (;;) {
    const result = summarizeStatus(await params.fetchStatuses(), params.context)
    params.onPoll?.(result)
    if (result.kind === 'settled') {
      return result
    }
    const elapsed = now() - startedAt
    if (result.kind === 'missing' && elapsed >= Math.min(params.startTimeoutMs, params.maxWaitMs)) {
      return result
    }
    if (elapsed >= params.maxWaitMs) {
      return result
    }
    await sleep(params.pollMs)
  }
}
