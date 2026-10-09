import { describe, expect, test } from 'vitest'
import { pullRequestNumberFromPayload } from '../src/inputs'
import { diffFromFiles, toPrInfo } from '../src/pull-request'

describe('toPrInfo', () => {
  test('uses gh pr view field names', () => {
    const info = toPrInfo(
      {
        number: 1,
        title: 'title',
        body: null,
        user: { login: 'renovate[bot]', type: 'Bot' },
        head: { ref: 'feature', sha: 'h' },
        base: { ref: 'main', sha: 'b' },
      },
      [
        { filename: 'a.tf', status: 'modified', additions: 1, deletions: 2 },
        {
          filename: 'c.tf',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          previous_filename: 'b.tf',
        },
      ]
    )
    expect(info).toStrictEqual({
      number: 1,
      title: 'title',
      body: '',
      author: { login: 'renovate[bot]', is_bot: true },
      headRefName: 'feature',
      baseRefName: 'main',
      headRefOid: 'h',
      baseRefOid: 'b',
      files: [
        { path: 'a.tf', additions: 1, deletions: 2, status: 'modified' },
        { path: 'c.tf', additions: 0, deletions: 0, status: 'renamed', previousPath: 'b.tf' },
      ],
    })
  })
})

describe('diffFromFiles', () => {
  test('builds a unified diff from per-file patches', () => {
    expect(
      diffFromFiles([
        {
          filename: 'new.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+x',
        },
        { filename: 'bin.png', status: 'modified', additions: 0, deletions: 0 },
      ])
    ).toBe(
      'diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+x\n' +
        'diff --git a/bin.png b/bin.png\n# patch unavailable (binary or too large)\n'
    )
  })
})

describe('pullRequestNumberFromPayload', () => {
  test.each([
    [{ pull_request: { number: 3 } }, 3],
    [{ issue: { number: 4, pull_request: {} } }, 4],
    [{ issue: { number: 5 } }, null],
    [{}, null],
  ])('%j', (payload, expected) => {
    expect(pullRequestNumberFromPayload(payload)).toBe(expected)
  })
})
