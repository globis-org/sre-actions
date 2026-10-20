import { describe, expect, test } from 'vitest'
import { parsePlanLog, renderDiagnostic } from '../src/hcp-log'

const line = (message: object): string => JSON.stringify({ '@level': 'info', ...message })

describe('parsePlanLog', () => {
  test('structured: collects planned changes, diagnostics, error messages and the trailer', () => {
    const parsed = parsePlanLog(
      [
        '\u0002Terraform v1.16.0',
        'on linux_amd64',
        'Initializing plugins and modules...',
        line({ type: 'version', terraform: '1.16.0', ui: '1.3' }),
        line({
          type: 'planned_change',
          change: { resource: { addr: 'aws_s3_bucket.a' }, action: 'create' },
        }),
        line({
          type: 'planned_change',
          change: {
            resource: { addr: 'module.b.aws_sqs_queue.this' },
            previous_resource: { addr: 'aws_sqs_queue.b' },
            action: 'move',
          },
        }),
        line({
          type: 'planned_change',
          change: {
            resource: { addr: 'aws_instance.c' },
            action: 'replace',
            reason: 'cannot_update',
          },
        }),
        line({
          type: 'diagnostic',
          diagnostic: { severity: 'error', summary: 'Unsupported attribute', detail: 'x' },
        }),
        line({ '@level': 'error', '@message': 'Terraform exited with code 1' }),
        'Operation failed: failed running terraform plan (exit 1)',
      ].join('\n')
    )
    expect(parsed).toStrictEqual({
      format: 'structured',
      changes: [
        { address: 'aws_s3_bucket.a', action: 'create' },
        {
          address: 'module.b.aws_sqs_queue.this',
          action: 'move',
          previousAddress: 'aws_sqs_queue.b',
        },
        { address: 'aws_instance.c', action: 'replace', reason: 'cannot_update' },
      ],
      diagnostics: [{ severity: 'error', summary: 'Unsupported attribute', detail: 'x' }],
      messages: [
        'Terraform exited with code 1',
        'Operation failed: failed running terraform plan (exit 1)',
      ],
    })
  })

  test('text: strips ANSI colors and starts the body at the plan', () => {
    const parsed = parsePlanLog(
      [
        'Terraform v1.16.0',
        'Initializing plugins and modules...',
        '\u001b[0m\u001b[1mTerraform used the selected providers to generate the following execution plan.\u001b[0m',
        '',
        '  \u001b[32m#\u001b[0m aws_s3_bucket.a will be created',
        '',
        'Plan: 1 to add, 0 to change, 0 to destroy.',
      ].join('\r\n')
    )
    expect(parsed).toStrictEqual({
      format: 'text',
      body: [
        'Terraform used the selected providers to generate the following execution plan.',
        '',
        '  # aws_s3_bucket.a will be created',
        '',
        'Plan: 1 to add, 0 to change, 0 to destroy.',
      ].join('\n'),
      diagnostics: [],
      messages: [],
    })
  })

  test('text: an init failure keeps the whole log when no plan marker exists', () => {
    const parsed = parsePlanLog(
      'Terraform v1.16.0\nOperation failed: failed running terraform init (exit 1)'
    )
    expect(parsed.format).toBe('text')
    expect(parsed.messages).toStrictEqual([
      'Operation failed: failed running terraform init (exit 1)',
    ])
  })

  test('lines that look like JSON but are not UI messages are treated as text', () => {
    const parsed = parsePlanLog('{"foo": 1}\n{not json')
    expect(parsed.format).toBe('text')
  })
})

describe('renderDiagnostic', () => {
  test('with range and snippet', () => {
    expect(
      renderDiagnostic({
        severity: 'error',
        summary: 'Unsupported attribute',
        detail: 'This object has no argument named "foo".',
        range: { filename: 'main.tf', start: { line: 12 } },
        snippet: { context: 'resource "aws_s3_bucket" "a"', code: '  foo = 1', start_line: 12 },
      })
    ).toBe(
      [
        'Error: Unsupported attribute',
        '',
        '  on main.tf line 12, in resource "aws_s3_bucket" "a":',
        '    12:   foo = 1',
        '',
        'This object has no argument named "foo".',
      ].join('\n')
    )
  })

  test('with address only', () => {
    expect(
      renderDiagnostic({
        severity: 'warning',
        summary: 'Deprecated value used',
        address: 'aws_iam_role.a',
      })
    ).toBe(['Warning: Deprecated value used', '', '  with aws_iam_role.a'].join('\n'))
  })
})
