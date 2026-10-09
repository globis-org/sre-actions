export type StatusRecord = {
  context: string
  state: string
  description: string | null
  created_at: string
}

export type StatusSummary =
  | { kind: 'missing' }
  | { kind: 'pending'; firstCreatedAt: string; description: string }
  | { kind: 'settled'; state: string; firstCreatedAt: string; description: string }

// plan の完了を待つのはこの action の責務にしない (wait-for-commit-status など前段で待つ)。
// 待機を軽い runner の前段ジョブに置き、plan の結果でレビュー自体を skip する判断もそこで
// できるようにするため。この action は実行時点の状態を 1 回だけ読む。
//
// statuses (Status API は新しい順) から context の最新の状態と、最初に付いた時刻を求める。
// 最初の status の時刻は「この commit に対する plan が始まった時刻」で、それより前の plan コメントは
// 古い head に対するものと判断できる (push 時刻を Activity API で取るより権限・形式の前提が少ない)
export function summarizeStatus(statuses: StatusRecord[], context: string): StatusSummary {
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

export type ProjectStatus = { state: string; description: string }

// Atlantis は集約の status に加えて project ごとに "<context>: <project>" の status を付ける。
// <project> は名前付き project なら project 名、それ以外は "<dir>/<workspace>"
export function latestProjectStatuses(
  statuses: StatusRecord[],
  context: string
): Map<string, ProjectStatus> {
  const prefix = `${context}: `
  const latest = new Map<string, ProjectStatus>()
  for (const status of statuses) {
    if (!status.context.startsWith(prefix)) {
      continue
    }
    const name = status.context.slice(prefix.length)
    if (!latest.has(name)) {
      latest.set(name, { state: status.state, description: status.description ?? '' })
    }
  }
  return latest
}
