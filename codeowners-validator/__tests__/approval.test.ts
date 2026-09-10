import { evaluateApprovals } from '../src/approval'

describe('evaluateApprovals', () => {
  test('approved when an owner of every owned file approved', () => {
    const result = evaluateApprovals(
      [
        { filename: 'src/main.ts', requiredUsers: ['alice', 'bob'] },
        { filename: 'docs/guide.md', requiredUsers: ['alice', 'carol'] },
      ],
      ['alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })

  test('not approved when a file lacks approval from its own owners', () => {
    const result = evaluateApprovals(
      [
        { filename: 'src/main.ts', requiredUsers: ['alice', 'bob'] },
        { filename: 'docs/guide.md', requiredUsers: ['alice', 'carol'] },
      ],
      ['carol']
    )
    expect(result).toEqual({ approved: false, unapprovedFiles: ['src/main.ts'] })
  })

  test('approved when the only owned file is approved by its owner', () => {
    const result = evaluateApprovals(
      [{ filename: 'docs/guide.md', requiredUsers: ['alice', 'carol'] }],
      ['carol']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['carol'] })
  })

  test('files without owners do not require approval', () => {
    const result = evaluateApprovals(
      [
        { filename: 'README.md', requiredUsers: [] },
        { filename: 'src/main.ts', requiredUsers: ['alice'] },
      ],
      ['alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })

  test('approved by anyone when no file has owners', () => {
    expect(evaluateApprovals([{ filename: 'README.md', requiredUsers: [] }], ['dave'])).toEqual({
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
      [{ filename: 'src/main.ts', requiredUsers: ['alice'] }],
      ['dave', 'alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })

  test('deduplicates approvers who reviewed multiple times', () => {
    const result = evaluateApprovals(
      [{ filename: 'src/main.ts', requiredUsers: ['alice'] }],
      ['alice', 'alice']
    )
    expect(result).toEqual({ approved: true, approvedBy: ['alice'] })
  })
})
