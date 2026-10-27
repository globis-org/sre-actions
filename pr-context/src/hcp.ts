// HCP Terraform の speculative plan の結果を、commit status と HCP Terraform API から組み立てる。
//
// - workspace の集合は head commit に付いた "Terraform Cloud/<org>/<workspace>" の status で決める。
//   status の target_url が run を指し、plan の件数と log-read-url は run の plan API から取る
// - 変更リソースは JSON plan (json-output-redacted) から取る。ログから取らないのは、Console UI の
//   workspace ではテキストを解釈することになり、Terraform の表示が変わると黙って取りこぼすため
// - 件数の正解は plan API (resource-additions / changes / destructions)。JSON plan の変更リソースと
//   突き合わせ、合わなければ incomplete にする (Atlantis と同じ方針)

import { parsePlanLog, renderDiagnostic, type ParsedLog } from './hcp-log'
import {
  parseJsonPlan,
  renderResourceChange,
  type JsonPlan,
  type ResourceChange,
} from './json-plan'
import {
  STATE_ORDER,
  type Plan,
  type PlanState,
  type Project,
  type Resource,
  type ResourceAction,
} from './plan'
import type { PlanReader, PlanSummary } from './tfc'

export type HcpStatusRecord = {
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

const STATUS_PREFIX = 'Terraform Cloud/'

export function classifyStatus(status: HcpStatusRecord): WorkspaceStatus {
  const runUrl = status.target_url
  const runId = runUrl === null ? null : (/\/runs\/(run-[A-Za-z0-9]+)/.exec(runUrl)?.[1] ?? null)
  const description = status.description ?? ''
  switch (status.state) {
    case 'pending':
      return { kind: 'pending', runId, runUrl, description }
    case 'success':
      // trigger されなかった workspace は success だが run へのリンクを持たない
      if (runId === null || runUrl === null) {
        return { kind: 'untriggered', description }
      }
      return { kind: 'finished', runId, runUrl, description }
    default:
      return { kind: 'errored', runId, runUrl, description }
  }
}

// head commit の HCP Terraform の status を workspace 名ごとの最新 (Status API は新しい順) に絞る
export function workspaceStatuses(
  statuses: HcpStatusRecord[],
  organization: string
): Map<string, WorkspaceStatus> {
  const prefix = `${STATUS_PREFIX}${organization}/`
  const result = new Map<string, WorkspaceStatus>()
  for (const status of statuses) {
    const workspace = status.context.startsWith(prefix) ? status.context.slice(prefix.length) : null
    if (workspace !== null && !result.has(workspace)) {
      result.set(workspace, classifyStatus(status))
    }
  }
  return new Map([...result].toSorted(([a], [b]) => a.localeCompare(b)))
}

// data source の read は変更に含めない (属性の差分の描画には使う)。
// import と同時に update されるリソースは update として出る (actions が update のまま importing が付く)
export function resourcesFromJsonPlan(plan: JsonPlan): Resource[] {
  return plan.changes.flatMap(({ address, action, previousAddress }) => {
    if (action === 'read') {
      return []
    }
    return [
      previousAddress === undefined ? { address, action } : { address, action, previousAddress },
    ]
  })
}

// add = create + replace、change = update、destroy = delete + replace。
// import は単独のものと update 等に併記されるもの (importing) があり数が合わないので見ない。
// move / forget は plan API の件数に含まれない
export function countsMatch(
  summary: Pick<PlanSummary, 'additions' | 'changes' | 'destructions'>,
  resources: Resource[]
): boolean {
  const actual = (...actions: ResourceAction[]): number =>
    resources.filter(r => actions.includes(r.action)).length
  return (
    summary.additions === actual('create', 'replace') &&
    summary.changes === actual('update') &&
    summary.destructions === actual('delete', 'replace')
  )
}

export function errorReason(log: ParsedLog | null): string | undefined {
  if (log === null) {
    return undefined
  }
  const diagnostic = log.diagnostics.find(d => d.severity === 'error')
  if (diagnostic !== undefined) {
    return `Error: ${diagnostic.summary}`
  }
  const errorLine =
    log.format === 'text'
      ? log.body
          .split('\n')
          .map(l => l.replace(/^│\s*/, '').trim())
          .find(l => l.startsWith('Error: '))
      : undefined
  return errorLine ?? log.messages[0]
}

const fence = (body: string, lang = ''): string => `\`\`\`${lang}\n${body}\n\`\`\``

// plan-details.md の workspace ごとの節。text はログの plan 本体をそのまま、structured (とログを
// 取れなかった場合) は diagnostic と JSON plan から描画した属性の差分 (失敗した run は diagnostic と
// messages だけ)
export function renderWorkspaceLog(
  workspace: string,
  runUrl: string | null,
  log: ParsedLog | null,
  changes: ResourceChange[] = []
): string {
  const blocks =
    log?.format === 'text'
      ? [fence(log.body)]
      : [
          log !== null &&
            log.diagnostics.length > 0 &&
            fence(log.diagnostics.map(renderDiagnostic).join('\n\n')),
          changes.length > 0 && fence(changes.map(renderResourceChange).join('\n\n'), 'diff'),
          log !== null && log.messages.length > 0 && fence(log.messages.join('\n')),
        ]
  return `${[`## ${workspace}`, runUrl !== null && `run: ${runUrl}`, ...blocks]
    .filter(block => block !== false)
    .join('\n\n')}\n`
}

type Outcome = { project: Project; log?: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function toOutcome(
  reader: PlanReader,
  workspace: string,
  status: WorkspaceStatus,
  warn: (message: string) => void
): Promise<Outcome> {
  const description = 'description' in status ? status.description : ''
  const base: Project = {
    project: workspace,
    state: 'incomplete',
    status: description,
    resources: [],
  }
  switch (status.kind) {
    case 'pending':
      return { project: { ...base, state: 'pending' } }
    case 'untriggered':
      return { project: { ...base, state: 'untriggered' } }
    case 'errored': {
      // 失敗の理由を取るためにログを読む。取れなくても失敗であることは status から分かる
      const project: Project = { ...base, state: 'failed' }
      let log: ParsedLog | null = null
      try {
        const plan = status.runId === null ? null : await reader.getPlanForRun(status.runId)
        log = plan?.logReadUrl ? parsePlanLog(await reader.fetchLog(plan.logReadUrl)) : null
      } catch (error) {
        warn(`Failed to fetch plan for ${workspace}: ${message(error)}`)
      }
      // 失敗した run の節は理由を読むためのもので、変更の粒度 (detail) は付けない
      const reason = errorReason(log)
      return {
        project: reason === undefined ? project : { ...project, reason },
        ...(log === null ? {} : { log: renderWorkspaceLog(workspace, status.runUrl, log) }),
      }
    }
    case 'finished': {
      let plan: PlanSummary | null
      try {
        plan = await reader.getPlanForRun(status.runId)
      } catch (error) {
        warn(`Failed to fetch plan for ${workspace}: ${message(error)}`)
        return { project: { ...base, reason: `HCP Terraform API: ${message(error)}` } }
      }
      if (plan === null) {
        return { project: { ...base, reason: 'plan を取得できない' } }
      }
      if (!plan.hasChanges) {
        // 変更の無い workspace のために JSON plan (数 MB) を取らない。forget だけの plan で
        // has-changes が false になるなら、その forget はここで見えなくなる (未確認)。
        // Atlantis と同じく、plan を実行した workspace には節を残す
        return {
          project: { ...base, state: 'no-changes' },
          log: `## ${workspace}\n\nrun: ${status.runUrl}\n\nNo changes.\n`,
        }
      }
      let json: JsonPlan
      try {
        json = parseJsonPlan(await reader.fetchRedactedPlan(plan.id))
      } catch (error) {
        warn(`Failed to fetch the JSON plan for ${workspace}: ${message(error)}`)
        // ログから一覧を作り直さない。テキストの解釈に戻ると、取りこぼしても気づけない
        return { project: { ...base, reason: 'JSON plan を取得できない' } }
      }
      // ログは plan-details.md の描画 (Console UI の plan 本体、structured の diagnostic) にだけ使う。
      // 一覧の照合は JSON plan だけで済むので、取れなくても incomplete にはしない
      let log: ParsedLog | null = null
      try {
        log = plan.logReadUrl === null ? null : parsePlanLog(await reader.fetchLog(plan.logReadUrl))
      } catch (error) {
        warn(`Failed to fetch the plan log for ${workspace}: ${message(error)}`)
      }
      const resources = resourcesFromJsonPlan(json)
      const rendered = renderWorkspaceLog(workspace, status.runUrl, log, json.changes)
      const detailed = { ...base, resources, hasDetails: true }
      // 件数が合っても一覧を信用しない。plan API は add / change / destroy しか数えないので、
      // 解釈できない変更がそれ以外の種類だと、件数の照合では気づけない
      const [first, ...others] = json.unknown
      if (first !== undefined) {
        const rest = others.length > 0 ? ` ほか ${others.length} 件` : ''
        return { project: { ...detailed, reason: `未知の action: ${first}${rest}` }, log: rendered }
      }
      return countsMatch(plan, resources)
        ? { project: { ...detailed, state: 'changes' }, log: rendered }
        : {
            project: { ...detailed, reason: 'リソース数が plan の件数と合わない' },
            log: rendered,
          }
    }
  }
}

// - none:        head commit に HCP Terraform の status が無い
// - pending:     run が終わっていない workspace がある (この action は待たない。前段で待つ)。
//                終わった workspace の表と変更リソースはそのまま出す
// - no-projects: 全 workspace が trigger されなかった (Terraform に関係しない PR)
function planState(projects: Project[]): PlanState {
  if (projects.length === 0) {
    return 'none'
  }
  if (projects.some(p => p.state === 'pending')) {
    return 'pending'
  }
  if (projects.every(p => p.state === 'untriggered')) {
    return 'no-projects'
  }
  return STATE_ORDER.find(s => projects.some(p => p.state === s)) ?? 'no-changes'
}

export function buildPlan(projects: Project[]): Plan {
  return {
    state: planState(projects),
    projects,
    resources: projects.flatMap(p => p.resources.map(r => ({ ...r, project: p.project }))),
  }
}

export async function collectHcpPlan(
  reader: PlanReader,
  workspaces: Map<string, WorkspaceStatus>,
  warn: (message: string) => void
): Promise<{ plan: Plan; latest: string }> {
  // workspace ごとに直列に取る (API のレート制限を踏まないため。待ち時間は workspace あたり 1 秒程度)
  const outcomes: Outcome[] = []
  for (const [workspace, status] of workspaces) {
    outcomes.push(await toOutcome(reader, workspace, status, warn))
  }
  return {
    plan: buildPlan(outcomes.map(o => o.project)),
    latest: outcomes
      .map(o => o.log)
      .filter(log => log !== undefined)
      .join('\n'),
  }
}
