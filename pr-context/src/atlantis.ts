// Atlantis の plan 結果を、commit status とコメントから組み立てる。
//
// - 状態の正解は commit status。Atlantis は集約の "atlantis/plan" に加えて、project ごとに
//   "atlantis/plan: <project>" を付け、description に Plan 行 / "No changes." / 失敗を入れる。
//   <project> は名前付き project なら project 名、それ以外は "<dir>/<workspace>"
// - コメントから取るのは、status に載らない変更リソースの address と失敗の理由だけ。
//   抽出したリソース数を status の Plan 行と突き合わせ、合わなければ incomplete にする
//   (出力の打ち切り・コメントの欠落・未知の書式で、黙って「destroy なし」と報告しないため)

export const STATUS_CONTEXT = 'atlantis/plan'

// main.ts はこの理由を見てコメントを取り直す
export const MISSING_COMMENT = 'plan コメントが見つからない'

export type StatusRecord = {
  context: string
  state: string
  description: string | null
  created_at: string
}

export type IssueComment = {
  login: string
  type: string
  createdAt: string
  body: string
}

export type ResourceAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'replace'
  | 'import'
  | 'move'
  | 'forget'

export type Resource = { address: string; action: ResourceAction; previousAddress?: string }

export type ProjectState = 'changes' | 'no-changes' | 'failed' | 'incomplete'

export type Project = {
  project: string
  state: ProjectState
  // status の description (Plan 行など)
  status: string
  // 失敗の理由や incomplete の理由
  reason?: string
  resources: Resource[]
}

// - pending:     plan が終わっていない (この action は待たない。前段で待つ)
// - none:        head commit に plan の status が無い
// - no-projects: plan は実行されたが対象 project が無い (Terraform に関係しない PR)
export type PlanState = 'pending' | 'none' | 'no-projects' | ProjectState

export type Plan = {
  state: PlanState
  projects: Project[]
  // project をまたいで address と action で重複を除いた一覧
  resources: Resource[]
}

export type Aggregate =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'settled'; state: string; description: string; since: string }

// Status API は新しい順。最初に付いた時刻より前の plan コメントは古い head に対するもの
export function aggregateStatus(statuses: StatusRecord[]): Aggregate {
  const matched = statuses.filter(s => s.context === STATUS_CONTEXT)
  const latest = matched[0]
  if (latest === undefined) {
    return { kind: 'none' }
  }
  if (latest.state === 'pending') {
    return { kind: 'pending' }
  }
  return {
    kind: 'settled',
    state: latest.state,
    description: latest.description ?? '',
    since: matched.at(-1)?.created_at ?? latest.created_at,
  }
}

function projectStatuses(statuses: StatusRecord[]): Map<string, StatusRecord> {
  const prefix = `${STATUS_CONTEXT}: `
  const latest = new Map<string, StatusRecord>()
  for (const status of statuses) {
    const name = status.context.startsWith(prefix) ? status.context.slice(prefix.length) : null
    if (name !== null && !latest.has(name)) {
      latest.set(name, status)
    }
  }
  return latest
}

const CONTINUED = 'Continued plan output from previous comment'
const PLAN_COMMENT = /^(Ran Plan for|\*\*Plan (Error|Failed)\*\*)/

// REST API は GitHub App のログイン名に "[bot]" を付け、GraphQL (gh pr view) は付けない
const normalizeLogin = (name: string): string => name.replace(/\[bot\]$/, '').toLowerCase()

// since 以降に Atlantis (Bot) が投稿した plan コメントを時系列に並べ、分割された続きを前につなぐ
export function selectPlanComments(
  comments: IssueComment[],
  login: string,
  since: string
): string[] {
  const merged: string[] = []
  for (const comment of comments
    .filter(c => c.type === 'Bot' && normalizeLogin(c.login) === normalizeLogin(login))
    .filter(c => Date.parse(c.createdAt) >= Date.parse(since))
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const body = comment.body.replace(/\r\n/g, '\n').trimStart()
    if (body.startsWith(CONTINUED)) {
      // 続きの元が since より前なら、続きだけでは解釈できないので捨てる
      if (merged.length > 0) {
        merged[merged.length - 1] += `\n${body}`
      }
    } else if (PLAN_COMMENT.test(body)) {
      merged.push(body)
    }
  }
  return merged
}

// 節の見出し: 1 project なら "Ran Plan for dir: ...", 複数なら "### 1. dir: ..."。
// 複数のときの目次 ("1. dir: ...") は見出しではない
const HEADER =
  /^(?:Ran Plan for |#{1,6} (?:\d+\. )?)(?:project: `([^`]+)` )?dir: `([^`]*)` workspace: `([^`]+)`/

// project ごとに最後の節を返す。キーは project ごとの status と同じ名前
export function lastSections(comments: string[]): Map<string, string> {
  const sections = new Map<string, string>()
  for (const comment of comments) {
    let current: { name: string; lines: string[] } | null = null
    const flush = (): void => {
      if (current !== null) {
        sections.set(current.name, current.lines.join('\n'))
      }
    }
    for (const line of comment.split('\n')) {
      const match = HEADER.exec(line.trim())
      if (match === null) {
        current?.lines.push(line)
        continue
      }
      flush()
      const [, name, dir, workspace] = match
      current = { name: name ?? `${dir === '' ? '.' : dir}/${workspace}`, lines: [] }
    }
    flush()
  }
  return sections
}

const RESOURCE_PATTERNS: [RegExp, ResourceAction][] = [
  [/^(.+?) will be created$/, 'create'],
  [/^(.+?) will be updated in-place$/, 'update'],
  [/^(.+?) will be destroyed$/, 'delete'],
  [/^(.+?) (?:is tainted, so )?must be replaced$/, 'replace'],
  [/^(.+?) will be replaced, as requested$/, 'replace'],
  [/^(.+?) will be imported$/, 'import'],
  [/^(.+?) will no longer be managed by Terraform$/, 'forget'],
]

// terraform plan のテキスト出力の "# <address> ..." 行。data source の read は変更に含めない
export function parseResourceLine(line: string): Resource | null {
  const text = /^[\s+\-~!/<=]*#\s+(.+?)\s*$/.exec(line)?.[1]
  if (text === undefined) {
    return null
  }
  const moved = /^(.+?) has moved to (.+)$/.exec(text)
  if (moved?.[1] !== undefined && moved[2] !== undefined) {
    return { address: moved[2], action: 'move', previousAddress: moved[1] }
  }
  for (const [pattern, action] of RESOURCE_PATTERNS) {
    const address = pattern.exec(text)?.[1]
    if (address !== undefined) {
      return { address: address.replace(/ \(deposed object [^)]+\)$/, ''), action }
    }
  }
  return null
}

function dedupe(resources: Resource[]): Resource[] {
  const seen = new Set<string>()
  return resources.filter(r => {
    const key = `${r.action} ${r.address}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
}

// add = create + replace、change = update、destroy = delete + replace。
// import は "will be imported" 単独のものと update 等に併記されるものがあり数が合わないので見ない
export function countsMatch(planLine: string, resources: Resource[]): boolean {
  const expected = (kind: string): number =>
    Number(new RegExp(`(\\d+) to ${kind}\\b`).exec(planLine)?.[1] ?? 0)
  const actual = (...actions: ResourceAction[]): number =>
    resources.filter(r => actions.includes(r.action)).length
  return (
    expected('add') === actual('create', 'replace') &&
    expected('change') === actual('update') &&
    expected('destroy') === actual('delete', 'replace') &&
    expected('forget') === actual('forget')
  )
}

// "**Plan Failed**: <理由>" はその行、"**Plan Error**" は続くコードブロックの最初の行
export function failureReason(text: string): string | undefined {
  const lines = text.split('\n').map(line => line.trim())
  const index = lines.findIndex(line => /^(\*\*)?Plan (Error|Failed)/.test(line))
  if (index === -1) {
    return undefined
  }
  const rest = (lines[index] ?? '').replace(/^.*?Plan (Error|Failed)(\*\*)?:?\s*/, '')
  return rest || lines.slice(index + 1).find(line => line !== '' && !line.startsWith('```'))
}

function toProject(name: string, status: StatusRecord, section: string | undefined): Project {
  const description = status.description ?? ''
  const project: Project = {
    project: name,
    state: 'incomplete',
    status: description,
    resources: [],
  }
  if (status.state === 'failure' || status.state === 'error') {
    const reason = section === undefined ? undefined : failureReason(section)
    return { ...project, state: 'failed', ...(reason === undefined ? {} : { reason }) }
  }
  if (status.state !== 'success') {
    return { ...project, reason: `status が ${status.state}` }
  }
  if (description.startsWith('No changes.')) {
    return { ...project, state: 'no-changes' }
  }
  if (!description.startsWith('Plan:')) {
    return { ...project, reason: '未知の status' }
  }
  if (section === undefined) {
    return { ...project, reason: MISSING_COMMENT }
  }
  const resources = dedupe(
    section
      .split('\n')
      .map(parseResourceLine)
      .filter(r => r !== null)
  )
  return countsMatch(description, resources)
    ? { ...project, state: 'changes', resources }
    : { ...project, resources, reason: 'リソース数が Plan 行と合わない' }
}

const STATE_ORDER: ProjectState[] = ['failed', 'incomplete', 'changes', 'no-changes']

export function buildPlan(
  aggregate: Aggregate,
  statuses: StatusRecord[],
  comments: string[]
): Plan {
  if (aggregate.kind !== 'settled') {
    return { state: aggregate.kind, projects: [], resources: [] }
  }
  if (aggregate.description.startsWith('0/0 ')) {
    return { state: 'no-projects', projects: [], resources: [] }
  }
  const sections = lastSections(comments)
  const projects = [...projectStatuses(statuses)]
    .map(([name, status]) => toProject(name, status, sections.get(name)))
    .toSorted((a, b) => a.project.localeCompare(b.project))
  if (projects.length === 0) {
    // atlantis.yaml の誤りなどコマンド全体の失敗では project ごとの status が付かない
    const reason = failureReason(comments.at(-1) ?? '')
    const project: Project = {
      project: '(全体)',
      state: aggregate.state === 'success' ? 'incomplete' : 'failed',
      status: aggregate.description,
      ...(reason === undefined ? {} : { reason }),
      resources: [],
    }
    return { state: project.state, projects: [project], resources: [] }
  }
  const state = STATE_ORDER.find(s => projects.some(p => p.state === s)) ?? 'no-changes'
  return { state, projects, resources: dedupe(projects.flatMap(p => p.resources)) }
}
