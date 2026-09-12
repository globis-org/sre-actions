import type { Diagnostic, ParsedLog, PlannedChange } from './log'
import type { PlanSummary } from './tfc'

export type ResultKind = 'finished' | 'errored' | 'pending' | 'untriggered' | 'missing'

export type WorkspaceResult = {
  workspace: string
  kind: ResultKind
  runId: string | null
  runUrl: string | null
  description: string
  plan: PlanSummary | null
  log: ParsedLog | null
}

export const COMMENT_MARKER = '<!-- sre-actions/hcp-terraform-plan -->'

// GitHub のコメント本文上限は 65,536 文字。余裕を持たせる
export const DEFAULT_MAX_LENGTH = 65_000

export type RenderOptions = {
  sha: string
  showUntriggered: boolean
  maxLength?: number
}

export function renderComment(results: WorkspaceResult[], options: RenderOptions): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const visible = results.filter(result => options.showUntriggered || result.kind !== 'untriggered')
  const hidden = results.length - visible.length

  const head = [
    COMMENT_MARKER,
    '## HCP Terraform Plan',
    '',
    '| Workspace | Status | Changes | Run |',
    '| --- | --- | --- | --- |',
    ...visible.map(renderTableRow),
    '',
  ]
  if (hidden > 0) {
    head.push(`<sub>${hidden} workspace(s) not triggered by this change are hidden.</sub>`, '')
  }
  const footer = [
    '',
    `<sub>Speculative plans for ${options.sha.slice(0, 7)} · sre-actions/hcp-terraform-plan</sub>`,
  ]

  const blocks = visible
    .filter(result => result.kind === 'finished' || result.kind === 'errored')
    .map(renderDetails)
  const budget = maxLength - head.join('\n').length - footer.join('\n').length
  return [...head, ...fitBlocks(blocks, budget), ...footer].join('\n')
}

// 予算に収まるように details ブロックを詰める。収まらないブロックは本文を打ち切り、以降は省略する
function fitBlocks(blocks: { workspace: string; text: string }[], budget: number): string[] {
  const output: string[] = []
  const omitted: string[] = []
  let used = 0
  let full = false
  for (const block of blocks) {
    if (full) {
      omitted.push(block.workspace)
      continue
    }
    const length = block.text.length + 1
    if (used + length <= budget) {
      output.push(block.text, '')
      used += length + 1
      continue
    }
    // 最初に収まらなかったブロックで打ち切り、以降は省略する
    full = true
    const remaining = budget - used - 200
    if (remaining > 500) {
      let truncated = block.text.slice(0, remaining)
      // コードフェンスの途中で切れた場合は閉じる (escapeFence により本文中の ``` は自前のフェンスのみ)
      if ((truncated.match(/```/g)?.length ?? 0) % 2 === 1) {
        truncated += '\n```'
      }
      output.push(`${truncated}\n\n… (truncated, see the run link)\n\n</details>`)
    } else {
      omitted.push(block.workspace)
    }
  }
  if (omitted.length > 0) {
    output.push(
      '',
      `<sub>Details omitted for ${omitted.join(', ')} due to the comment size limit. See the run links above.</sub>`
    )
  }
  return output
}

function statusLabel(result: WorkspaceResult): string {
  switch (result.kind) {
    case 'finished':
      if (result.plan === null) {
        return '❔ Finished (plan unavailable)'
      }
      return result.plan.hasChanges ? '🟡 Changes' : '✅ No changes'
    case 'errored':
      return '❌ Errored'
    case 'pending':
      return '⏳ Pending'
    case 'untriggered':
      return '⚪ Not triggered'
    case 'missing':
      return '❔ No status'
  }
}

function changesLabel(result: WorkspaceResult): string {
  const plan = result.plan
  if (result.kind !== 'finished' || plan === null) {
    return '-'
  }
  const parts = [`+${plan.additions}`, `~${plan.changes}`, `-${plan.destructions}`]
  if (plan.imports > 0) {
    parts.push(`↓${plan.imports}`)
  }
  return `\`${parts.join(' ')}\``
}

function renderTableRow(result: WorkspaceResult): string {
  const run = result.runUrl === null ? '-' : `[${result.runId ?? 'run'}](${result.runUrl})`
  return `| \`${result.workspace}\` | ${statusLabel(result)} | ${changesLabel(result)} | ${run} |`
}

function renderDetails(result: WorkspaceResult): { workspace: string; text: string } {
  const lines: string[] = [
    '<details>',
    `<summary><b>${result.workspace}</b> — ${summaryText(result)}</summary>`,
    '',
  ]
  if (result.log === null) {
    lines.push(
      result.kind === 'errored'
        ? 'Plan log is not available. See the run for details.'
        : 'Plan log is not available.'
    )
  } else if (result.log.format === 'text') {
    lines.push('```', escapeFence(result.log.body), '```')
  } else {
    if (result.log.diagnostics.length > 0) {
      lines.push(
        '```',
        escapeFence(result.log.diagnostics.map(renderDiagnostic).join('\n\n')),
        '```',
        ''
      )
    }
    if (result.log.changes.length > 0) {
      lines.push('```diff', escapeFence(result.log.changes.map(renderChange).join('\n')), '```', '')
    } else if (result.kind === 'finished' && result.log.diagnostics.length === 0) {
      lines.push('No resource changes.', '')
    }
    if (result.log.messages.length > 0) {
      lines.push('```', escapeFence(result.log.messages.join('\n')), '```')
    }
  }
  if (lines.at(-1) !== '') {
    lines.push('')
  }
  lines.push('</details>')
  return { workspace: result.workspace, text: lines.join('\n') }
}

function summaryText(result: WorkspaceResult): string {
  if (result.kind === 'errored') {
    return result.description || 'Terraform plan errored'
  }
  const plan = result.plan
  if (plan === null) {
    return result.description
  }
  if (!plan.hasChanges) {
    return 'No changes'
  }
  const parts = [
    `${plan.additions} to add`,
    `${plan.changes} to change`,
    `${plan.destructions} to destroy`,
  ]
  if (plan.imports > 0) {
    parts.push(`${plan.imports} to import`)
  }
  return parts.join(', ')
}

// diff ハイライトが効くように action ごとに接頭辞を付ける
const ACTION_PREFIX: Record<string, string> = {
  create: '+   create ',
  update: '!   update ',
  delete: '-   destroy',
  replace: '-/+ replace',
  read: '<=  read   ',
  move: '>   move   ',
  import: '+   import ',
  noop: '    noop   ',
}

export function renderChange(change: PlannedChange): string {
  const prefix = ACTION_PREFIX[change.action] ?? `    ${change.action}`
  const suffix = [
    change.previousAddress === undefined ? '' : ` (from ${change.previousAddress})`,
    change.reason === undefined ? '' : ` (${change.reason})`,
  ].join('')
  return `${prefix} ${change.address}${suffix}`
}

// Terraform CLI の診断メッセージ表示に倣う
export function renderDiagnostic(diagnostic: Diagnostic): string {
  const heading = `${diagnostic.severity === 'warning' ? 'Warning' : 'Error'}: ${diagnostic.summary}`
  const lines = [heading]
  if (diagnostic.range !== undefined) {
    const context =
      diagnostic.snippet?.context === undefined ? '' : `, in ${diagnostic.snippet.context}`
    lines.push(
      '',
      `  on ${diagnostic.range.filename} line ${diagnostic.range.start.line}${context}:`
    )
    if (diagnostic.snippet !== undefined) {
      const codeLines = diagnostic.snippet.code.split('\n')
      codeLines.forEach((code, index) => {
        lines.push(`  ${String(diagnostic.snippet!.start_line + index).padStart(4)}: ${code}`)
      })
    }
  } else if (diagnostic.address !== undefined) {
    lines.push('', `  with ${diagnostic.address}`)
  }
  if (diagnostic.detail !== undefined && diagnostic.detail.length > 0) {
    lines.push('', diagnostic.detail.trim())
  }
  return lines.join('\n')
}

// コードフェンスを閉じてしまう ``` を無害化する
function escapeFence(text: string): string {
  return text.replaceAll('```', "'''")
}
