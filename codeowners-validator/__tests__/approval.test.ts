import { evaluateApprovals, listApprovers, resolveRequiredUsers } from '../src/approval'
import { getFileOwners, parseCodeOwners } from '../src/parse'

describe('evaluateApprovals', () => {
  test('approved when an owner of every owned file approved', () => {
    const result = evaluateApprovals(
      [
        { filename: 'infra/core/main.tf', requiredUsers: ['core-a', 'core-b'] },
        { filename: 'infra/app/settings.yaml', requiredUsers: ['core-a', 'app-a'] },
      ],
      ['core-a']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['core-a'] })
  })

  test('not approved when a file lacks approval from its own owners', () => {
    const result = evaluateApprovals(
      [
        { filename: 'infra/core/main.tf', requiredUsers: ['core-a', 'core-b'] },
        { filename: 'infra/app/settings.yaml', requiredUsers: ['core-a', 'app-a'] },
      ],
      ['app-a']
    )
    expect(result).toEqual({ approved: false, unapprovedFiles: ['infra/core/main.tf'] })
  })

  test('approved when the only owned file is approved by its owner', () => {
    const result = evaluateApprovals(
      [{ filename: 'infra/app/settings.yaml', requiredUsers: ['core-a', 'app-a'] }],
      ['app-a']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['app-a'] })
  })

  test('files without owners do not require approval', () => {
    const result = evaluateApprovals(
      [
        { filename: 'README.md', requiredUsers: [] },
        { filename: 'infra/core/main.tf', requiredUsers: ['core-a'] },
      ],
      ['core-a']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['core-a'] })
  })

  test('approved by anyone when no file has owners', () => {
    expect(evaluateApprovals([{ filename: 'README.md', requiredUsers: [] }], ['someone'])).toEqual({
      approved: true,
      approvedBy: [],
    })
  })

  test('not approved when no file has owners and nobody approved', () => {
    expect(evaluateApprovals([{ filename: 'README.md', requiredUsers: [] }], [])).toEqual({
      approved: false,
      unapprovedFiles: [],
    })
  })

  test('approvers not owning any file are ignored', () => {
    const result = evaluateApprovals(
      [{ filename: 'infra/core/main.tf', requiredUsers: ['core-a'] }],
      ['outsider', 'core-a']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['core-a'] })
  })

  test('deduplicates approvers who reviewed multiple times', () => {
    const result = evaluateApprovals(
      [{ filename: 'infra/core/main.tf', requiredUsers: ['core-a'] }],
      ['core-a', 'core-a']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['core-a'] })
  })
})

describe('resolveRequiredUsers', () => {
  const usersByOwner = new Map([
    ['org/core', ['core-a', 'core-b']],
    ['org/app', ['app-a']],
    ['some-user', ['some-user']],
  ])

  test('expands owners into a deduplicated user list per file', () => {
    const result = resolveRequiredUsers(
      [
        {
          filename: 'infra/app/settings.yaml',
          owners: [
            { kind: 'team', name: 'org/core', org: 'org', team: 'core' },
            { kind: 'team', name: 'org/app', org: 'org', team: 'app' },
            { kind: 'user', name: 'some-user' },
          ],
        },
        { filename: 'README.md', owners: [] },
      ],
      usersByOwner
    )
    expect(result).toEqual([
      {
        filename: 'infra/app/settings.yaml',
        requiredUsers: ['core-a', 'core-b', 'app-a', 'some-user'],
      },
      { filename: 'README.md', requiredUsers: [] },
    ])
  })

  test('throws when a matched owner resolves to no users', () => {
    expect(() =>
      resolveRequiredUsers(
        [
          {
            filename: 'infra/core/main.tf',
            owners: [{ kind: 'team', name: 'org/empty', org: 'org', team: 'empty' }],
          },
        ],
        new Map([['org/empty', []]])
      )
    ).toThrow('Owner "org/empty" has no users to approve.')
  })

  test('throws when a matched owner is missing from the map', () => {
    expect(() =>
      resolveRequiredUsers(
        [{ filename: 'infra/core/main.tf', owners: [{ kind: 'user', name: 'unknown' }] }],
        usersByOwner
      )
    ).toThrow('Owner "unknown" has no users to approve.')
  })
})

const review = (login: string, state: string) => ({ state, user: { login } })

describe('listApprovers', () => {
  test('lists users whose latest review is APPROVED', () => {
    expect(listApprovers([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')])).toEqual([
      'a',
    ])
  })

  test('a later comment does not revoke an approval', () => {
    expect(listApprovers([review('a', 'APPROVED'), review('a', 'COMMENTED')])).toEqual(['a'])
  })

  test('a later changes-requested revokes an approval', () => {
    expect(listApprovers([review('a', 'APPROVED'), review('a', 'CHANGES_REQUESTED')])).toEqual([])
  })

  test('an approval after changes-requested counts', () => {
    expect(listApprovers([review('a', 'CHANGES_REQUESTED'), review('a', 'APPROVED')])).toEqual([
      'a',
    ])
  })

  test('a dismissed approval does not count', () => {
    expect(listApprovers([review('a', 'DISMISSED')])).toEqual([])
  })

  test('pending reviews and reviews without a user are ignored', () => {
    expect(listApprovers([review('a', 'PENDING'), { state: 'APPROVED', user: null }])).toEqual([])
  })

  test('returns each approver once', () => {
    expect(listApprovers([review('a', 'APPROVED'), review('a', 'APPROVED')])).toEqual(['a'])
  })
})

describe('end-to-end from CODEOWNERS text', () => {
  const codeowners = `
    * @org/core @approve-bot[bot]
    infra/app/settings.yaml @org/core @org/app
  `
  const usersByOwner = new Map([
    ['org/core', ['core-a', 'core-b']],
    ['org/app', ['app-a']],
    ['approve-bot[bot]', ['approve-bot[bot]']],
  ])
  const evaluate = (files: string[], approvers: string[]) =>
    evaluateApprovals(
      resolveRequiredUsers(getFileOwners(files, parseCodeOwners(codeowners)), usersByOwner),
      approvers
    )

  test('the specific rule alone is satisfied by its own owner', () => {
    expect(evaluate(['infra/app/settings.yaml'], ['app-a'])).toEqual({
      approved: true,
      approvedBy: ['app-a'],
    })
  })

  test('a file matched by the specific rule and one by the wildcard need the wildcard owner too', () => {
    expect(evaluate(['infra/app/settings.yaml', 'infra/core/main.tf'], ['app-a'])).toEqual({
      approved: false,
      unapprovedFiles: ['infra/core/main.tf'],
    })
  })

  test('the wildcard owner covers both files', () => {
    expect(evaluate(['infra/app/settings.yaml', 'infra/core/main.tf'], ['core-b'])).toEqual({
      approved: true,
      approvedBy: ['core-b'],
    })
  })

  test('an owner listed only on the wildcard does not cover the specific rule', () => {
    expect(evaluate(['infra/app/settings.yaml'], ['approve-bot[bot]'])).toEqual({
      approved: false,
      unapprovedFiles: ['infra/app/settings.yaml'],
    })
    expect(evaluate(['infra/core/main.tf'], ['approve-bot[bot]'])).toEqual({
      approved: true,
      approvedBy: ['approve-bot[bot]'],
    })
  })
})
