import { describe, expect, test } from 'vitest'
import { TfcClient } from '../src/tfc'

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body?: unknown; text?: string }
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { status, body, text } = handler(String(input), init)
    return new Response(text ?? (body === undefined ? null : JSON.stringify(body)), {
      status,
      statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Forbidden',
    })
  }) as typeof fetch
}

describe('TfcClient', () => {
  test('getPlanForRun reads the plan attributes with the bearer token', async () => {
    const seen: { url: string; auth: string | undefined }[] = []
    const client = new TfcClient(
      'app.terraform.io',
      'secret',
      fakeFetch((url, init) => {
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') ?? undefined })
        return {
          status: 200,
          body: {
            data: {
              id: 'plan-xyz',
              attributes: {
                status: 'finished',
                'has-changes': true,
                'resource-additions': 1,
                'resource-changes': null,
                'resource-destructions': 2,
                'resource-imports': 0,
                'log-read-url': 'https://archivist.example/log',
              },
            },
          },
        }
      })
    )
    expect(await client.getPlanForRun('run-abc')).toStrictEqual({
      id: 'plan-xyz',
      hasChanges: true,
      additions: 1,
      changes: 0,
      destructions: 2,
      logReadUrl: 'https://archivist.example/log',
    })
    expect(seen).toStrictEqual([
      { url: 'https://app.terraform.io/api/v2/runs/run-abc/plan', auth: 'Bearer secret' },
    ])
  })

  test('getPlanForRun returns null on 404 and throws on other errors', async () => {
    const client = new TfcClient(
      'app.terraform.io',
      'secret',
      fakeFetch(url => ({ status: url.includes('run-missing') ? 404 : 403 }))
    )
    expect(await client.getPlanForRun('run-missing')).toBeNull()
    await expect(client.getPlanForRun('run-denied')).rejects.toThrow(
      'HCP Terraform API request failed: GET /runs/run-denied/plan -> 403 Forbidden'
    )
  })

  test('fetchRedactedPlan follows the 307 to the signed URL without the token', async () => {
    const seen: { url: string; auth: string | null; redirect: string | undefined }[] = []
    const client = new TfcClient('app.terraform.io', 'secret', (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input)
      seen.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      })
      if (url.endsWith('/json-output-redacted')) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://archivist.example/plan.json' },
        })
      }
      return new Response('{"resource_changes": []}', { status: 200 })
    }) as typeof fetch)
    expect(await client.fetchRedactedPlan('plan-xyz')).toBe('{"resource_changes": []}')
    expect(seen).toStrictEqual([
      {
        url: 'https://app.terraform.io/api/v2/plans/plan-xyz/json-output-redacted',
        auth: 'Bearer secret',
        redirect: 'manual',
      },
      { url: 'https://archivist.example/plan.json', auth: null, redirect: undefined },
    ])
  })

  test('fetchRedactedPlan throws when the plan JSON is not available (204)', async () => {
    const client = new TfcClient(
      'app.terraform.io',
      'secret',
      (async () => new Response(null, { status: 204 })) as typeof fetch
    )
    await expect(client.fetchRedactedPlan('plan-xyz')).rejects.toThrow(
      'HCP Terraform API request failed: GET /plans/plan-xyz/json-output-redacted -> 204'
    )
  })

  test('fetchLog returns the body without an authorization header', async () => {
    const seen: (string | undefined)[] = []
    const client = new TfcClient(
      'app.terraform.io',
      'secret',
      fakeFetch((_, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? undefined)
        return { status: 200, text: 'log body' }
      })
    )
    expect(await client.fetchLog('https://archivist.example/log')).toBe('log body')
    expect(seen).toStrictEqual([undefined])
  })
})
