import { describe, expect, test } from 'vitest'
import { TfcApiError, TfcClient } from '../src/tfc'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  })
}

function workspace(
  name: string,
  identifier: string | null,
  speculative = true,
  branch: string | null = ''
) {
  return {
    id: `ws-${name}`,
    attributes: {
      name,
      'speculative-enabled': speculative,
      'vcs-repo': identifier === null ? null : { identifier, branch },
    },
  }
}

describe('TfcClient.listWorkspacesForRepo', () => {
  test('follows pagination and filters by repository (case-insensitive), keeping speculative and branch flags', async () => {
    const calls: string[] = []
    const fetchFn: typeof fetch = input => {
      const url = String(input)
      calls.push(url)
      if (url.includes('page%5Bnumber%5D=1')) {
        return Promise.resolve(
          jsonResponse({
            data: [
              workspace('b', 'My-Org/Infra-App'),
              workspace('other', 'my-org/another-repo'),
              workspace('no-vcs', null),
            ],
            meta: { pagination: { 'next-page': 2 } },
          })
        )
      }
      return Promise.resolve(
        jsonResponse({
          data: [
            workspace('a', 'my-org/infra-app', true, null),
            workspace('disabled', 'my-org/infra-app', false),
            workspace('release', 'my-org/infra-app', true, 'release'),
          ],
          meta: { pagination: { 'next-page': null } },
        })
      )
    }
    const client = new TfcClient('app.terraform.io', 'token', fetchFn)
    await expect(client.listWorkspacesForRepo('my-org', 'my-org/infra-app')).resolves.toStrictEqual(
      [
        { name: 'a', speculativeEnabled: true, branch: '' },
        { name: 'b', speculativeEnabled: true, branch: '' },
        { name: 'disabled', speculativeEnabled: false, branch: '' },
        { name: 'release', speculativeEnabled: true, branch: 'release' },
      ]
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('/api/v2/organizations/my-org/workspaces?')
  })

  test('throws TfcApiError with the status code on failure', async () => {
    const client = new TfcClient('app.terraform.io', 'token', () =>
      Promise.resolve(jsonResponse({ errors: [] }, 401))
    )
    await expect(client.listWorkspacesForRepo('my-org', 'my-org/infra-app')).rejects.toBeInstanceOf(
      TfcApiError
    )
    await expect(client.listWorkspacesForRepo('my-org', 'my-org/infra-app')).rejects.toMatchObject({
      status: 401,
    })
  })
})

describe('TfcClient.getPlanForRun', () => {
  test('maps plan attributes and treats null counts as 0', async () => {
    const client = new TfcClient('app.terraform.io', 'token', () =>
      Promise.resolve(
        jsonResponse({
          data: {
            id: 'plan-1',
            attributes: {
              status: 'finished',
              'has-changes': true,
              'resource-additions': 2,
              'resource-changes': null,
              'resource-destructions': 1,
              'resource-imports': 0,
              'log-read-url': 'https://archivist.example/log',
            },
          },
        })
      )
    )
    await expect(client.getPlanForRun('run-1')).resolves.toStrictEqual({
      status: 'finished',
      hasChanges: true,
      additions: 2,
      changes: 0,
      destructions: 1,
      imports: 0,
      logReadUrl: 'https://archivist.example/log',
    })
  })

  test('returns null when the run has no plan', async () => {
    const client = new TfcClient('app.terraform.io', 'token', () =>
      Promise.resolve(jsonResponse({ errors: [] }, 404))
    )
    await expect(client.getPlanForRun('run-1')).resolves.toBeNull()
  })

  test('throws TfcApiError on 403', async () => {
    const client = new TfcClient('app.terraform.io', 'token', () =>
      Promise.resolve(jsonResponse({ errors: [] }, 403))
    )
    await expect(client.getPlanForRun('run-1')).rejects.toMatchObject({ status: 403 })
  })
})
