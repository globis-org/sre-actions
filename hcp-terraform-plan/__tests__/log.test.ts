import { describe, expect, test } from 'vitest'
import { parsePlanLog, stripAnsi } from '../src/log'

const STX = String.fromCodePoint(2)
const ESC = String.fromCodePoint(27)

function line(message: Record<string, unknown>): string {
  return JSON.stringify({
    '@module': 'terraform.ui',
    '@timestamp': '2026-01-01T00:00:00Z',
    ...message,
  })
}

describe('parsePlanLog (structured run output)', () => {
  test('collects planned changes, summary and outputs', () => {
    const raw = [
      `${STX}Terraform v1.16.1`,
      'on linux_amd64',
      'Initializing plugins and modules...',
      line({ '@level': 'info', '@message': 'Terraform 1.16.1', type: 'version' }),
      line({ '@level': 'info', '@message': 'x: Refreshing state...', type: 'refresh_start' }),
      line({
        '@level': 'info',
        '@message': 'aws_iam_role.example: Plan to create',
        type: 'planned_change',
        change: { resource: { addr: 'aws_iam_role.example' }, action: 'create' },
      }),
      line({
        '@level': 'info',
        '@message': 'aws_instance.web: Plan to replace',
        type: 'planned_change',
        change: { resource: { addr: 'aws_instance.web' }, action: 'replace', reason: 'requested' },
      }),
      line({
        '@level': 'info',
        '@message': 'Plan: 1 to add, 0 to change, 1 to destroy.',
        type: 'change_summary',
        changes: { add: 1, change: 0, remove: 1, import: 0, operation: 'plan' },
      }),
      '',
    ].join('\n')

    const parsed = parsePlanLog(raw)
    expect(parsed.format).toBe('structured')
    if (parsed.format !== 'structured') return
    expect(parsed.changes).toStrictEqual([
      { address: 'aws_iam_role.example', action: 'create' },
      { address: 'aws_instance.web', action: 'replace', reason: 'requested' },
    ])
    expect(parsed.summary).toStrictEqual({ add: 1, change: 0, remove: 1, import: 0 })
    expect(parsed.diagnostics).toStrictEqual([])
    expect(parsed.messages).toStrictEqual([])
  })

  test('collects diagnostics and the operation failure trailer for errored runs', () => {
    const raw = [
      `${STX}Terraform v1.16.1`,
      'on linux_amd64',
      'Initializing plugins and modules...',
      line({
        '@level': 'info',
        '@message': 'Initializing modules...',
        type: 'init_output',
        message_code: 'x',
      }),
      line({
        '@level': 'error',
        '@message': 'Error: Unsupported Terraform Core version',
        type: 'diagnostic',
        diagnostic: {
          severity: 'error',
          summary: 'Unsupported Terraform Core version',
          detail: 'This configuration does not support Terraform version 1.16.1.',
          range: {
            filename: 'providers.tf',
            start: { line: 2, column: 3, byte: 20 },
            end: { line: 2, column: 30, byte: 47 },
          },
          snippet: {
            context: 'terraform',
            code: '  required_version = "~> 1.11.0"',
            start_line: 2,
            highlight_start_offset: 2,
            highlight_end_offset: 29,
            values: [],
          },
        },
      }),
      'Operation failed: failed running terraform init (exit 1)',
    ].join('\n')

    const parsed = parsePlanLog(raw)
    expect(parsed.format).toBe('structured')
    if (parsed.format !== 'structured') return
    expect(parsed.diagnostics).toHaveLength(1)
    expect(parsed.diagnostics[0]?.summary).toBe('Unsupported Terraform Core version')
    expect(parsed.diagnostics[0]?.range?.filename).toBe('providers.tf')
    expect(parsed.messages).toStrictEqual([
      'Operation failed: failed running terraform init (exit 1)',
    ])
    expect(parsed.changes).toStrictEqual([])
    expect(parsed.summary).toBeNull()
  })
})

describe('parsePlanLog (console UI text)', () => {
  test('strips ANSI codes and slices from the plan body', () => {
    const raw = [
      'Terraform v1.16.1',
      'on linux_amd64',
      'Initializing plugins and modules...',
      'aws_iam_role.example: Refreshing state... [id=example]',
      '',
      `${ESC}[0m${ESC}[1mTerraform used the selected providers to generate the following execution plan.${ESC}[0m`,
      '',
      `  ${ESC}[32m+${ESC}[0m create`,
      '',
      'Plan: 1 to add, 0 to change, 0 to destroy.',
    ].join('\n')

    const parsed = parsePlanLog(raw)
    expect(parsed.format).toBe('text')
    if (parsed.format !== 'text') return
    expect(parsed.body.startsWith('Terraform used the selected providers')).toBe(true)
    expect(parsed.body).not.toContain('Refreshing state')
    expect(parsed.body).not.toContain(ESC)
    expect(parsed.body.endsWith('Plan: 1 to add, 0 to change, 0 to destroy.')).toBe(true)
  })

  test('stripAnsi removes color sequences', () => {
    expect(stripAnsi(`${ESC}[1m${ESC}[32m+${ESC}[0m create`)).toBe('+ create')
  })
})
