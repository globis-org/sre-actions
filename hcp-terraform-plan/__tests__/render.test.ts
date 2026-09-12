import { describe, expect, test } from 'vitest'
import {
  COMMENT_MARKER,
  renderChange,
  renderComment,
  renderDiagnostic,
  type WorkspaceResult,
} from '../src/render'

const RUN_URL = 'https://app.terraform.io/app/my-org/infra-app-prod/runs/run-AbC123xyz'

function finished(overrides: Partial<WorkspaceResult> = {}): WorkspaceResult {
  return {
    workspace: 'infra-app-prod',
    kind: 'finished',
    runId: 'run-AbC123xyz',
    runUrl: RUN_URL,
    description: 'Terraform plan: 1 to add, 0 to change, 0 to destroy.',
    plan: {
      status: 'finished',
      hasChanges: true,
      additions: 1,
      changes: 0,
      destructions: 0,
      imports: 0,
      logReadUrl: 'https://archivist.example/log',
    },
    log: {
      format: 'structured',
      changes: [{ address: 'aws_iam_role.example', action: 'create' }],
      diagnostics: [],
      summary: { add: 1, change: 0, remove: 0, import: 0 },
      messages: [],
    },
    ...overrides,
  }
}

describe('renderComment', () => {
  test('renders the marker, a table row and a details block', () => {
    const body = renderComment([finished()], { sha: 'abcdef1234567890', showUntriggered: false })
    expect(body.startsWith(COMMENT_MARKER)).toBe(true)
    expect(body).toContain(
      '| `infra-app-prod` | 🟡 Changes | `+1 ~0 -0` | [run-AbC123xyz](' + RUN_URL + ') |'
    )
    expect(body).toContain(
      '<summary><b>infra-app-prod</b> — 1 to add, 0 to change, 0 to destroy</summary>'
    )
    expect(body).toContain('+   create  aws_iam_role.example')
    expect(body).toContain('abcdef1')
  })

  test('hides untriggered workspaces by default and shows them on request', () => {
    const results: WorkspaceResult[] = [
      finished(),
      {
        workspace: 'infra-app-stg',
        kind: 'untriggered',
        runId: null,
        runUrl: null,
        description: 'Run not triggered',
        plan: null,
        log: null,
      },
    ]
    const hidden = renderComment(results, { sha: 'abcdef1', showUntriggered: false })
    expect(hidden).not.toContain('infra-app-stg')
    expect(hidden).toContain('1 workspace(s) not triggered by this change are hidden')

    const shown = renderComment(results, { sha: 'abcdef1', showUntriggered: true })
    expect(shown).toContain('| `infra-app-stg` | ⚪ Not triggered | - | - |')
  })

  test('renders diagnostics and trailer messages for errored runs', () => {
    const errored = finished({
      kind: 'errored',
      description: 'Terraform plan errored',
      plan: {
        status: 'errored',
        hasChanges: false,
        additions: 0,
        changes: 0,
        destructions: 0,
        imports: 0,
        logReadUrl: 'x',
      },
      log: {
        format: 'structured',
        changes: [],
        summary: null,
        diagnostics: [
          {
            severity: 'error',
            summary: 'Unsupported Terraform Core version',
            detail: 'This configuration does not support Terraform version 1.16.1.',
            range: { filename: 'providers.tf', start: { line: 2 } },
            snippet: {
              context: 'terraform',
              code: '  required_version = "~> 1.11.0"',
              start_line: 2,
            },
          },
        ],
        messages: ['Operation failed: failed running terraform init (exit 1)'],
      },
    })
    const body = renderComment([errored], { sha: 'abcdef1', showUntriggered: false })
    expect(body).toContain('| `infra-app-prod` | ❌ Errored | - |')
    expect(body).toContain('<summary><b>infra-app-prod</b> — Terraform plan errored</summary>')
    expect(body).toContain('Error: Unsupported Terraform Core version')
    expect(body).toContain('  on providers.tf line 2, in terraform:')
    expect(body).toContain('     2:   required_version = "~> 1.11.0"')
    expect(body).toContain('Operation failed: failed running terraform init (exit 1)')
  })

  test('does not report "No changes" when the plan could not be fetched', () => {
    const body = renderComment([finished({ plan: null, log: null })], {
      sha: 'abcdef1',
      showUntriggered: false,
    })
    expect(body).toContain('| `infra-app-prod` | ❔ Finished (plan unavailable) | - |')
    expect(body).not.toContain('No changes')
    expect(body).toContain('Terraform plan: 1 to add, 0 to change, 0 to destroy.')
  })

  test('shows a fallback when the plan log is unavailable', () => {
    const body = renderComment([finished({ kind: 'errored', plan: null, log: null })], {
      sha: 'abcdef1',
      showUntriggered: false,
    })
    expect(body).toContain('Plan log is not available. See the run for details.')
  })

  test('truncates details to stay within the size limit', () => {
    const big = finished({
      log: {
        format: 'structured',
        changes: Array.from({ length: 500 }, (_, i) => ({
          address: `aws_iam_role.example_${i}`,
          action: 'create',
        })),
        diagnostics: [],
        summary: null,
        messages: [],
      },
    })
    const second = finished({ workspace: 'infra-app-stg' })
    const body = renderComment([big, second], {
      sha: 'abcdef1',
      showUntriggered: false,
      maxLength: 4000,
    })
    expect(body.length).toBeLessThanOrEqual(4000)
    expect(body).toContain('… (truncated, see the run link)')
    expect(body).toContain('Details omitted for infra-app-stg')
    // 打ち切ってもテーブル行は残る
    expect(body).toContain('| `infra-app-stg` | 🟡 Changes |')
    // details タグとコードフェンスが閉じている
    expect(body.split('<details>').length).toBe(body.split('</details>').length)
    expect((body.match(/```/g)?.length ?? 0) % 2).toBe(0)
  })
})

describe('renderChange', () => {
  test('uses diff-friendly prefixes', () => {
    expect(renderChange({ address: 'a.b', action: 'create' })).toBe('+   create  a.b')
    expect(renderChange({ address: 'a.b', action: 'update' })).toBe('!   update  a.b')
    expect(renderChange({ address: 'a.b', action: 'delete' })).toBe('-   destroy a.b')
    expect(renderChange({ address: 'a.b', action: 'replace', reason: 'requested' })).toBe(
      '-/+ replace a.b (requested)'
    )
    expect(renderChange({ address: 'a.c', action: 'move', previousAddress: 'a.b' })).toBe(
      '>   move    a.c (from a.b)'
    )
  })
})

describe('renderDiagnostic', () => {
  test('falls back to the resource address when there is no source range', () => {
    const text = renderDiagnostic({
      severity: 'error',
      summary: 'AccessDenied',
      detail: 'not authorized',
      address: 'aws_s3_bucket.example',
    })
    expect(text).toBe('Error: AccessDenied\n\n  with aws_s3_bucket.example\n\nnot authorized')
  })
})
