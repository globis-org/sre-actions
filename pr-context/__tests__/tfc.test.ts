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
