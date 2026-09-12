// HCP Terraform の plan ログ (log-read-url) を解釈する。
//
// workspace の User Interface 設定によって形式が変わる:
// - Structured Run Output (デフォルト): `terraform plan -json` 相当の JSON lines
//   (https://developer.hashicorp.com/terraform/internals/machine-readable-ui)
// - Console UI: `terraform plan` のテキスト出力 (ANSI カラー付き)

export type PlannedChange = {
  address: string
  action: string
  reason?: string
  previousAddress?: string
}

export type Diagnostic = {
  severity: string
  summary: string
  detail?: string
  address?: string
  range?: { filename: string; start: { line: number } }
  snippet?: { context?: string; code: string; start_line: number }
}

export type ChangeSummary = {
  add: number
  change: number
  remove: number
  import: number
}

export type ParsedLog =
  | {
      format: 'structured'
      changes: PlannedChange[]
      diagnostics: Diagnostic[]
      summary: ChangeSummary | null
      // error レベルの log メッセージと、JSON でない末尾行 ("Operation failed: ..." など)
      messages: string[]
    }
  | {
      format: 'text'
      body: string
      diagnostics: Diagnostic[]
      messages: string[]
    }

type UiMessage = {
  '@level'?: string
  '@message'?: string
  type?: string
  change?: {
    action?: string
    reason?: string
    resource?: { addr?: string }
    previous_resource?: { addr?: string }
  }
  changes?: { add?: number; change?: number; remove?: number; import?: number }
  diagnostic?: Diagnostic
}

const ESC = String.fromCodePoint(27)
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g')

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

// ログ先頭の STX などの制御文字を落とす (タブは残す)
function stripControlChars(line: string): string {
  return Array.from(line)
    .filter(char => char === '\t' || (char.codePointAt(0) ?? 0) >= 32)
    .join('')
}

// run の先頭に付くヘッダ行。エラー表示には不要なので除外する
const HEADER_PATTERN = /^(Terraform v\d|on [a-z0-9_]+$|Initializing plugins and modules\.\.\.$)/

// テキスト形式の plan で「ここから plan 本体」とみなす行
const TEXT_PLAN_START_PATTERN =
  /^(Terraform used the selected providers|Terraform will perform the following actions|No changes\.|Changes to Outputs:|Note: Objects have changed outside of Terraform|Terraform planned the following actions|╷|Error: |Warning: )/

function tryParseUiMessage(line: string): UiMessage | null {
  if (!line.startsWith('{')) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && '@level' in parsed) {
      return parsed as UiMessage
    }
  } catch {
    // JSON ではない行
  }
  return null
}

export function parsePlanLog(raw: string): ParsedLog {
  const lines = raw.split(/\r?\n/).map(line => stripControlChars(stripAnsi(line)))
  const messages: UiMessage[] = []
  const textLines: string[] = []
  for (const line of lines) {
    const message = tryParseUiMessage(line)
    if (message === null) {
      textLines.push(line)
    } else {
      messages.push(message)
    }
  }

  if (messages.length === 0) {
    return parseTextLog(textLines)
  }

  const changes: PlannedChange[] = []
  const diagnostics: Diagnostic[] = []
  const errorMessages: string[] = []
  let summary: ChangeSummary | null = null
  for (const message of messages) {
    switch (message.type) {
      case 'planned_change': {
        const address = message.change?.resource?.addr
        const action = message.change?.action
        if (address !== undefined && action !== undefined) {
          const change: PlannedChange = { address, action }
          if (message.change?.reason !== undefined) {
            change.reason = message.change.reason
          }
          if (message.change?.previous_resource?.addr !== undefined) {
            change.previousAddress = message.change.previous_resource.addr
          }
          changes.push(change)
        }
        break
      }
      case 'change_summary':
        summary = {
          add: message.changes?.add ?? 0,
          change: message.changes?.change ?? 0,
          remove: message.changes?.remove ?? 0,
          import: message.changes?.import ?? 0,
        }
        break
      case 'diagnostic':
        if (message.diagnostic !== undefined) {
          diagnostics.push(message.diagnostic)
        }
        break
      default:
        if (message['@level'] === 'error' && message['@message'] !== undefined) {
          errorMessages.push(message['@message'])
        }
    }
  }

  const trailer = textLines
    .map(line => line.trim())
    .filter(line => line.length > 0 && !HEADER_PATTERN.test(line))
  return {
    format: 'structured',
    changes,
    diagnostics,
    summary,
    messages: [...errorMessages, ...trailer],
  }
}

function parseTextLog(lines: string[]): ParsedLog {
  const stripped = lines
  const start = stripped.findIndex(line => TEXT_PLAN_START_PATTERN.test(line))
  const body = (start === -1 ? stripped : stripped.slice(start)).join('\n').trim()
  const messages = stripped
    .map(line => line.trim())
    .filter(line => line.startsWith('Operation failed:'))
  return { format: 'text', body, diagnostics: [], messages }
}
