import type { Plan, PlanState, ProjectState } from './atlantis'

const PLAN_LABELS: Record<PlanState, string> = {
  pending: 'plan 未完了',
  none: 'plan 無し',
  'no-projects': 'plan 対象 project なし',
  failed: 'plan 失敗',
  incomplete: 'リソース一覧を検証できない（要手動確認）',
  changes: '変更あり',
  'no-changes': '変更なし',
}

const PROJECT_LABELS: Record<ProjectState, string> = {
  failed: '失敗',
  incomplete: '要確認',
  changes: '変更あり',
  'no-changes': '変更なし',
}

// changes / no-changes / no-projects 以外は、一覧に載らないリソースがありうる
export function destroyOrReplace(plan: Plan): 'true' | 'false' | 'unknown' {
  if (plan.resources.some(r => r.action === 'delete' || r.action === 'replace')) {
    return 'true'
  }
  return ['changes', 'no-changes', 'no-projects'].includes(plan.state) ? 'false' : 'unknown'
}

// project ごとの最新の plan 出力。reviewer が属性の変更内容を確認するために読む。
// コメントの原文は再 plan や前の失敗も含み、どれが最新かの判断を LLM に残すため渡さない
export function renderLatestPlans(sections: Map<string, string>): string {
  return [...sections]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([project, text]) => `## ${project}\n\n${text.replace(/(\s*\n---)+\s*$/, '').trim()}\n`)
    .join('\n')
}

// 理由に <details> などが入っても GitHub で HTML として描画されて表が崩れないようにする
const cell = (text: string): string =>
  text.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ')

// reviewer の prompt とサマリーにそのまま貼る。列挙を LLM にさせないため決定的に作る
export function renderSummary(plan: Plan): string {
  const destructive = plan.resources.filter(r => r.action === 'delete' || r.action === 'replace')
  const verdict = destroyOrReplace(plan)
  const lines = [
    `plan: ${PLAN_LABELS[plan.state]}`,
    `destroy / replace: ${
      verdict === 'unknown'
        ? `不明（${PLAN_LABELS[plan.state]}）`
        : verdict === 'false'
          ? 'なし'
          : destructive.map(r => `\`${r.address}\` (${r.action}, ${r.project})`).join(', ')
    }`,
  ]
  if (plan.projects.length > 0) {
    lines.push('', '| project | 状態 | status | 理由 |', '|---|---|---|---|')
    for (const p of plan.projects) {
      lines.push(
        `| ${cell(p.project)} | ${PROJECT_LABELS[p.state]} | ${cell(p.status)} | ${cell(p.reason ?? '')} |`
      )
    }
    lines.push('', `変更リソース一覧（${plan.resources.length} 件）:`)
    for (const r of plan.resources) {
      const moved = r.previousAddress === undefined ? '' : ` (moved from \`${r.previousAddress}\`)`
      lines.push(`- ${r.project}: \`${r.address}\` ${r.action}${moved}`)
    }
  }
  return `${lines.join('\n')}\n`
}
