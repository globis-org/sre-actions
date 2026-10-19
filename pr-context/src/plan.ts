// plan の結果の共通モデル。Atlantis (atlantis.ts) と HCP Terraform (hcp.ts) の両方がこの型に組み立て、
// summary.ts が plan-summary.md と outputs にする

export type ResourceAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'replace'
  | 'import'
  | 'move'
  | 'forget'

export type Resource = { address: string; action: ResourceAction; previousAddress?: string }

// project をまたぐ一覧では、同じ address が workspace 違いで複数の project に出うるので project を持つ
export type ProjectResource = Resource & { project: string }

// pending (run が終わっていない) と untriggered (run が trigger されなかった) は HCP Terraform のみ
export type ProjectState =
  | 'changes'
  | 'no-changes'
  | 'failed'
  | 'incomplete'
  | 'pending'
  | 'untriggered'

export type Project = {
  project: string
  state: ProjectState
  // status の description (Plan 行など)
  status: string
  // 失敗の理由や incomplete の理由
  reason?: string
  resources: Resource[]
  // plan-details.md にこの project の節があるとき、その粒度。
  // attributes: 属性の差分を含む plan 出力、resources: 変更リソースの一覧と diagnostic のみ
  detail?: 'attributes' | 'resources'
}

// 全体の状態になりうる project の状態 (pending は全体の pending に、untriggered は無視される)
export type SettledState = Exclude<ProjectState, 'pending' | 'untriggered'>

// - pending:     plan が終わっていない (この action は待たない。前段で待つ)
// - none:        head commit に plan の status が無い
// - no-projects: plan は実行されたが対象 project が無い (Terraform に関係しない PR)
export type PlanState = 'pending' | 'none' | 'no-projects' | SettledState

export type Plan = {
  state: PlanState
  projects: Project[]
  resources: ProjectResource[]
}

const RESOURCE_PATTERNS: [RegExp, ResourceAction][] = [
  [/^(.+?) will be created$/, 'create'],
  [/^(.+?) will be updated in-place$/, 'update'],
  [/^(.+?) will be destroyed$/, 'delete'],
  [/^(.+?) (?:is tainted, so )?must be replaced$/, 'replace'],
  // ", as requested" (-replace) や " due to changes in replace_triggered_by" が続く
  [/^(.+?) will be replaced\b/, 'replace'],
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

// 全体の状態は、この順で最初に見つかった project の状態
export const STATE_ORDER: SettledState[] = ['failed', 'incomplete', 'changes', 'no-changes']
