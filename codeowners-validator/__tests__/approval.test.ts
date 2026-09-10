import { evaluateApprovals, listApprovers, resolveRequiredUsers } from '../src/approval'
import { getFileOwners, parseCodeOwners } from '../src/parse'

describe('evaluateApprovals', () => {
  test('approved when an owner of every owned file approved', () => {
    const result = evaluateApprovals(
      [
        { filename: 'infra/core/main.tf', requiredUsers: ['alice', 'bob'] },
        { filename: 'infra/app/settings.yaml', requiredUsers: ['alice', 'carol'] },
      ],
      ['alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })

  test('not approved when a file lacks approval from its own owners', () => {
    const result = evaluateApprovals(
      [
        { filename: 'infra/core/main.tf', requiredUsers: ['alice', 'bob'] },
        { filename: 'infra/app/settings.yaml', requiredUsers: ['alice', 'carol'] },
      ],
      ['carol']
    )
    expect(result).toEqual({ approved: false, unapprovedFiles: ['infra/core/main.tf'] })
  })

  test('approved when the only owned file is approved by its owner', () => {
    const result = evaluateApprovals(
      [{ filename: 'infra/app/settings.yaml', requiredUsers: ['alice', 'carol'] }],
      ['carol']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['carol'] })
  })

  test('files without owners do not require approval', () => {
    const result = evaluateApprovals(
      [
        { filename: 'README.md', requiredUsers: [] },
        { filename: 'infra/core/main.tf', requiredUsers: ['alice'] },
      ],
      ['alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
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
      [{ filename: 'infra/core/main.tf', requiredUsers: ['alice'] }],
      ['outsider', 'alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })

  test('deduplicates approvers who reviewed multiple times', () => {
    const result = evaluateApprovals(
      [{ filename: 'infra/core/main.tf', requiredUsers: ['alice'] }],
      ['alice', 'alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })
})

describe('resolveRequiredUsers', () => {
  const usersByOwner = new Map([
    ['org/core', ['alice', 'bob']],
    ['org/app', ['carol']],
    ['dave', ['dave']],
  ])

  test('expands owners into a deduplicated user list per file', () => {
    const result = resolveRequiredUsers(
      [
        {
          filename: 'infra/app/settings.yaml',
          owners: [
            { kind: 'team', name: 'org/core', org: 'org', team: 'core' },
            { kind: 'team', name: 'org/app', org: 'org', team: 'app' },
            { kind: 'user', name: 'dave' },
          ],
        },
        { filename: 'README.md', owners: [] },
      ],
      usersByOwner
    )
    expect(result).toEqual([
      {
        filename: 'infra/app/settings.yaml',
        requiredUsers: ['alice', 'bob', 'carol', 'dave'],
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
    expect(
      listApprovers([review('alice', 'APPROVED'), review('bob', 'CHANGES_REQUESTED')])
    ).toEqual(['alice'])
  })

  test('a later comment does not revoke an approval', () => {
    expect(listApprovers([review('alice', 'APPROVED'), review('alice', 'COMMENTED')])).toEqual([
      'alice',
    ])
  })

  test('a later changes-requested revokes an approval', () => {
    expect(
      listApprovers([review('alice', 'APPROVED'), review('alice', 'CHANGES_REQUESTED')])
    ).toEqual([])
  })

  test('an approval after changes-requested counts', () => {
    expect(
      listApprovers([review('alice', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')])
    ).toEqual(['alice'])
  })

  test('a dismissed approval does not count', () => {
    expect(listApprovers([review('alice', 'DISMISSED')])).toEqual([])
  })

  test('pending reviews and reviews without a user are ignored', () => {
    expect(listApprovers([review('alice', 'PENDING'), { state: 'APPROVED', user: null }])).toEqual(
      []
    )
  })

  test('returns each approver once', () => {
    expect(listApprovers([review('alice', 'APPROVED'), review('alice', 'APPROVED')])).toEqual([
      'alice',
    ])
  })
})

describe('end-to-end from CODEOWNERS text', () => {
  const codeowners = `
    * @org/core @approve-bot[bot]
    infra/app/settings.yaml @org/core @org/app
  `
  const usersByOwner = new Map([
    ['org/core', ['alice', 'bob']],
    ['org/app', ['carol']],
    ['approve-bot[bot]', ['approve-bot[bot]']],
  ])
  const evaluate = (files: string[], approvers: string[]) =>
    evaluateApprovals(
      resolveRequiredUsers(getFileOwners(files, parseCodeOwners(codeowners)), usersByOwner),
      approvers
    )

  test('the specific rule alone is satisfied by its own owner', () => {
    expect(evaluate(['infra/app/settings.yaml'], ['carol'])).toEqual({
      approved: true,
      approvedBy: ['carol'],
    })
  })

  test('a file matched by the specific rule and one by the wildcard need the wildcard owner too', () => {
    expect(evaluate(['infra/app/settings.yaml', 'infra/core/main.tf'], ['carol'])).toEqual({
      approved: false,
      unapprovedFiles: ['infra/core/main.tf'],
    })
  })

  test('the wildcard owner covers both files', () => {
    expect(evaluate(['infra/app/settings.yaml', 'infra/core/main.tf'], ['bob'])).toEqual({
      approved: true,
      approvedBy: ['bob'],
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
