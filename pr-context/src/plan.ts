// plan プロバイダ (現状は Atlantis のみ) に共通の結果の型と、状態の集約・描画。
//
// action の語彙は `terraform plan -json` の planned_change に合わせる
// (HCP Terraform の Structured Run Output と同じ語彙で、プロバイダを足しても揃う)。

export type ResourceAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'replace'
  | 'import'
  | 'move'
  | 'forget'

export type ResourceChange = {
  address: string
  action: ResourceAction
  previousAddress?: string
}

// project 単位 (Atlantis の dir / workspace、HCP Terraform の workspace) の最後の plan の結果
// incomplete: 抽出したリソースの件数が Plan 行と合わない (plan 出力の打ち切りなど)。
// 一覧に載らないリソースがありうるので、destroy / replace の有無も判断できない
export type ProjectState = 'changes' | 'no-changes' | 'failed' | 'unknown' | 'incomplete'

export type ProjectPlan = {
  project: string
  state: ProjectState
  // `Plan: 1 to add, 0 to change, 0 to destroy.` などの要約行。無ければ null
  summary: string | null
  resources: ResourceChange[]
  // 状態をそう判定した理由 (照合で不一致になったときなど)
  note?: string
}

// - disabled:   プロバイダが無効 (この action の設定で対象外)
// - pending:    待機時間内に plan が終わらなかった
// - none:       head commit に対する plan が無い
// - no-projects: plan は実行されたが対象の project が無い (Terraform に関係しない PR)
// - unknown:    plan のコメントはあるが形式を解釈できない (要手動確認)
// - failed:     いずれかの project の最後の plan が失敗
// - changes:    いずれかの project に変更がある
// - no-changes: 全 project が変更なし
export type PlanState =
  | 'disabled'
  | 'pending'
  | 'none'
  | 'no-projects'
  | 'unknown'
  | 'failed'
  | 'changes'
  | 'no-changes'

export type PlanResult = {
  provider: string | null
  state: PlanState
  projects: ProjectPlan[]
  // project をまたいで address と action で重複を除いた変更リソース一覧
  resources: ResourceChange[]
  // project に紐づかない失敗 (ロック取得失敗など、コマンド全体の失敗) のメッセージ
  errors: string[]
}

export function disabledPlan(): PlanResult {
  return { provider: null, state: 'disabled', projects: [], resources: [], errors: [] }
}

export function dedupeResources(resources: ResourceChange[]): ResourceChange[] {
  const seen = new Set<string>()
  const result: ResourceChange[] = []
  for (const resource of resources) {
    const key = `${resource.action}\u0000${resource.address}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(resource)
    }
  }
  return result
}

// project ごとの状態から全体の状態を決める。失敗 > 解釈不能 > 変更あり > 変更なし の順に強い
export function overallState(projects: ProjectPlan[], errors: string[]): PlanState {
  if (errors.length > 0 || projects.some(p => p.state === 'failed')) {
    return 'failed'
  }
  if (projects.length === 0) {
    return 'unknown'
  }
  if (projects.some(p => p.state === 'unknown' || p.state === 'incomplete')) {
    return 'unknown'
  }
  if (projects.some(p => p.state === 'changes')) {
    return 'changes'
  }
  return 'no-changes'
}

export function isDestructive(resource: ResourceChange): boolean {
  return resource.action === 'delete' || resource.action === 'replace'
}

const STATE_LABELS: Record<PlanState, string> = {
  disabled: '対象外',
  pending: 'plan 未完了',
  none: 'plan 無し',
  'no-projects': 'plan 対象 project なし',
  unknown: 'plan 形式不明（要手動確認）',
  failed: 'plan 失敗',
  changes: '変更あり',
  'no-changes': '変更なし',
}

const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  changes: '変更あり',
  'no-changes': '変更なし',
  failed: '失敗',
  unknown: '形式不明',
  incomplete: 'リソース一覧が Plan 行と不一致',
}

// 変更リソースがわからない状態。destroy / replace の有無も判断できない
export function isIndeterminate(state: PlanState): boolean {
  return state === 'pending' || state === 'none' || state === 'unknown' || state === 'failed'
}

// action の output 用。destroy / replace が無いと言い切れないときは unknown にする
export function destroyOrReplace(plan: PlanResult): 'true' | 'false' | 'unknown' {
  if (plan.resources.some(isDestructive)) {
    return 'true'
  }
  if (plan.state === 'disabled' || isIndeterminate(plan.state)) {
    return 'unknown'
  }
  return 'false'
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

// reviewer の prompt とサマリーにそのまま貼るための Markdown。決定的に作り、LLM に列挙させない
export function renderPlanSummary(plan: PlanResult): string {
  const lines: string[] = []
  const failedProjects = plan.projects.filter(p => p.state === 'failed').map(p => p.project)
  const stateLabel =
    plan.state === 'failed' && failedProjects.length > 0
      ? `${STATE_LABELS.failed}（${failedProjects.join(', ')}）`
      : STATE_LABELS[plan.state]
  lines.push(`plan: ${stateLabel}`)

  const destructive = plan.resources.filter(isDestructive)
  if (plan.state === 'disabled') {
    lines.push('destroy / replace: 対象外')
  } else if (isIndeterminate(plan.state)) {
    lines.push(`destroy / replace: 不明（${stateLabel}）`)
  } else if (destructive.length === 0) {
    lines.push('destroy / replace: なし')
  } else {
    lines.push(
      `destroy / replace: ${destructive.map(r => `\`${r.address}\` (${r.action})`).join(', ')}`
    )
  }

  if (plan.projects.length > 0) {
    lines.push('', '| project | 状態 | Plan 行 | 備考 |', '|---|---|---|---|')
    for (const project of plan.projects) {
      lines.push(
        `| ${escapeCell(project.project)} | ${PROJECT_STATE_LABELS[project.state]} | ${escapeCell(project.summary ?? '-')} | ${escapeCell(project.note ?? '')} |`
      )
    }
  }
  if (plan.errors.length > 0) {
    lines.push('', 'project に紐づかない失敗:')
    for (const error of plan.errors) {
      lines.push(`- ${escapeCell(error)}`)
    }
  }

  if (plan.state !== 'disabled') {
    lines.push('', `変更リソース一覧（${plan.resources.length} 件）:`)
    if (plan.resources.length === 0) {
      lines.push('- （空）')
    }
    for (const resource of plan.resources) {
      const moved =
        resource.previousAddress === undefined
          ? ''
          : ` (moved from \`${resource.previousAddress}\`)`
      lines.push(`- \`${resource.address}\` ${resource.action}${moved}`)
    }
  }
  return `${lines.join('\n')}\n`
}
