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
  // plan-details.md にこの project の属性の差分 (plan 出力) があるか。変更のある project にだけ付く
  hasDetails?: boolean
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
  // removed ブロックでは ", but will not be destroyed" が続く
  [/^(.+?) will no longer be managed by Terraform(?:, but will not be destroyed)?$/, 'forget'],
]

// "# <address> will ..." の形の行。"#" で始まる行をすべて見ないのは、属性の値の中の "# ..."
// (user_data のスクリプトなど) まで拾うため。値は深く字下げされているので、"#" の前は diff の
// 記号を含めて 4 文字までにする。動詞を行のどこかで探さず address の直後に限るのは、見出しの
// 補足 ("# (because ...)")、注記 ("# Warning: this will ...")、低い字下げで出る値の中の文
// ("# apiVersion: ... is ...") を誤検知しないため
const HEADING =
  /^[\s+\-~!/<=]{0,4}#\s+((?:[\w.-]|\[[^\]]*\])+(?: \(deposed object [^)]+\))? (?:will|must|is|has)\b.*?)\s*$/

// 変更ではない見出し: data source の read と、plan の前に出る drift の報告
const NOT_CHANGES = [/ will be read during apply$/, / has changed$/, / has been deleted$/]

// リソースの見出しの形をしているのに、変更としても変更でない見出しとしても解釈できない行か。
// 件数の照合だけに頼らないのは、Plan 行に数えられない変更 (forget など) の取りこぼしに
// 気づけないため
export function isUnknownResourceLine(line: string): boolean {
  const text = HEADING.exec(line)?.[1]
  return (
    text !== undefined &&
    !NOT_CHANGES.some(pattern => pattern.test(text)) &&
    parseResourceLine(line) === null
  )
}

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
