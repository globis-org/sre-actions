// Atlantis が PR に投稿する plan コメントを解釈する。
//
// コメントの形式 (Atlantis の既定テンプレート):
// - 1 project:  "Ran Plan for dir: `a` workspace: `default`" に続けて plan 出力
// - 複数:       "Ran Plan for N projects:" に続けて "### 1. dir: `a` workspace: `default`" ごとの節
// - project 名: "project: `name` dir: `a` workspace: `default`"
// - 失敗:       "**Plan Error**" / "**Plan Failed**" (project の節の中、またはコメント全体)
// - 分割:       長い出力は "Continued plan output from previous comment." で始まる次のコメントに続く

import {
  dedupeResources,
  overallState,
  type PlanResult,
  type ProjectPlan,
  type ProjectState,
  type ResourceAction,
  type ResourceChange,
} from './plan'

export type IssueComment = {
  author: string
  createdAt: string
  body: string
}

const PLAN_COMMENT_PREFIXES = [
  'Ran Plan for',
  '**Plan Error**',
  '**Plan Failed**',
  'Plan Error',
  'Plan Failed',
]
const CONTINUED_PREFIX = 'Continued plan output from previous comment'

function isPlanComment(body: string): boolean {
  const trimmed = body.trimStart()
  return (
    PLAN_COMMENT_PREFIXES.some(prefix => trimmed.startsWith(prefix)) ||
    trimmed.startsWith(CONTINUED_PREFIX)
  )
}

// since 以降に author が投稿した plan コメントを時系列で返す。分割コメントは前のコメントに連結する
export function selectPlanComments(
  comments: IssueComment[],
  params: { author: string; since: string }
): string[] {
  const since = Date.parse(params.since)
  const selected = comments
    .filter(c => c.author === params.author && Date.parse(c.createdAt) >= since)
    .filter(c => isPlanComment(c.body))
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  const merged: string[] = []
  for (const comment of selected) {
    const body = comment.body.replace(/\r\n/g, '\n')
    const last = merged.length - 1
    if (body.trimStart().startsWith(CONTINUED_PREFIX) && last >= 0) {
      merged[last] = `${merged[last]}\n${body}`
    } else if (!body.trimStart().startsWith(CONTINUED_PREFIX)) {
      // 続きの元になるコメントが since より前なら、続きだけでは解釈できないので捨てる
      merged.push(body)
    }
  }
  return merged
}

const PROJECT_PATTERN = /(?:project: `([^`]+)` )?dir: `([^`]*)` workspace: `([^`]+)`/

// 節の見出しになる行。"Ran Plan for N projects:" の直後の目次 ("1. dir: ...") は見出しではない
function projectHeader(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('Ran Plan for ') && !/^#{1,6} /.test(trimmed)) {
    return null
  }
  const match = PROJECT_PATTERN.exec(trimmed)
  if (match === null) {
    return null
  }
  const [, name, dir, workspace] = match
  const base = `dir: ${dir === '' ? '.' : dir} workspace: ${workspace}`
  return name === undefined ? base : `project: ${name} ${base}`
}

type ResourcePattern = { pattern: RegExp; action: ResourceAction }

// terraform plan のテキスト出力の "# <address> ..." 行。data source の read は変更に含めない
const RESOURCE_PATTERNS: ResourcePattern[] = [
  { pattern: /^(.+?) will be created$/, action: 'create' },
  { pattern: /^(.+?) will be updated in-place$/, action: 'update' },
  { pattern: /^(.+?) will be destroyed$/, action: 'delete' },
  { pattern: /^(.+?) (?:is tainted, so )?must be replaced$/, action: 'replace' },
  { pattern: /^(.+?) will be replaced, as requested$/, action: 'replace' },
  { pattern: /^(.+?) will be imported$/, action: 'import' },
  { pattern: /^(.+?) will no longer be managed by Terraform$/, action: 'forget' },
]
const MOVED_PATTERN = /^(.+?) has moved to (.+)$/
const DEPOSED_SUFFIX = / \(deposed object [^)]+\)$/

export function parseResourceLine(line: string): ResourceChange | null {
  // diff ブロック内の行頭の記号 (+ - ~ ! や -/+) と空白を除く
  const match = /^[\s+\-~!/<=]*#\s+(.+?)\s*$/.exec(line)
  if (match?.[1] === undefined) {
    return null
  }
  const text = match[1]
  const moved = MOVED_PATTERN.exec(text)
  if (moved?.[1] !== undefined && moved[2] !== undefined) {
    return { address: moved[2], action: 'move', previousAddress: moved[1] }
  }
  for (const { pattern, action } of RESOURCE_PATTERNS) {
    const found = pattern.exec(text)
    if (found?.[1] !== undefined) {
      return { address: found[1].replace(DEPOSED_SUFFIX, ''), action }
    }
  }
  return null
}

const FAILURE_PATTERN = /^\s*(?:\*\*)?Plan (?:Error|Failed)/m
const NO_CHANGES_PATTERN = /^\s*No changes\./m
const SUMMARY_PATTERN = /^\s*(Plan: .+? to destroy\.)/m
const OUTPUTS_ONLY_PATTERN = /^\s*Changes to Outputs:/m

function parseSection(text: string): Omit<ProjectPlan, 'project'> {
  const resources = dedupeResources(
    text
      .split('\n')
      .map(parseResourceLine)
      .filter((r): r is ResourceChange => r !== null)
  )
  const summary = SUMMARY_PATTERN.exec(text)?.[1] ?? null
  let state: ProjectState
  if (FAILURE_PATTERN.test(text)) {
    state = 'failed'
  } else if (summary !== null || OUTPUTS_ONLY_PATTERN.test(text) || resources.length > 0) {
    state = 'changes'
  } else if (NO_CHANGES_PATTERN.test(text)) {
    state = 'no-changes'
  } else {
    state = 'unknown'
  }
  return { state, summary: summary ?? (state === 'no-changes' ? 'No changes.' : null), resources }
}

// コメントが無い、または対象 project が無かった ("Ran Plan for 0 projects:") だけなら plan 無し
function noPlan(comments: string[], projects: ProjectPlan[], errors: string[]): boolean {
  return (
    projects.length === 0 &&
    errors.length === 0 &&
    comments.every(comment => comment.trimStart().startsWith('Ran Plan for 0 projects'))
  )
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0) ?? ''
  )
}

// 時系列のコメントから project ごとの最後の plan の結果を求める。
// 前の失敗は同じ project の後の plan で上書きされる。project に紐づかない失敗は、後で
// いずれかの project の plan が出れば解消したものとみなす
export function parsePlanComments(comments: string[]): PlanResult {
  const projects = new Map<string, ProjectPlan>()
  let errors: string[] = []

  for (const comment of comments) {
    const sections: { project: string; lines: string[] }[] = []
    for (const line of comment.split('\n')) {
      const header = projectHeader(line)
      if (header !== null) {
        sections.push({ project: header, lines: [] })
      } else {
        sections[sections.length - 1]?.lines.push(line)
      }
    }

    if (sections.length === 0) {
      const parsed = parseSection(comment)
      if (parsed.state === 'failed') {
        errors.push(firstLine(comment))
      }
      continue
    }
    errors = []
    for (const section of sections) {
      const text = section.lines.join('\n')
      projects.set(section.project, { project: section.project, ...parseSection(text) })
    }
  }

  const projectList = [...projects.values()].toSorted((a, b) => a.project.localeCompare(b.project))
  return {
    provider: 'atlantis',
    state: noPlan(comments, projectList, errors) ? 'none' : overallState(projectList, errors),
    projects: projectList,
    resources: dedupeResources(projectList.flatMap(p => p.resources)),
    errors,
  }
}
