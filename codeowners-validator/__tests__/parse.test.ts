import {
  replaceCodeOwnersPatternToGlobs,
  parseCodeOwners,
  getFileOwners,
  listUniqueOwners,
  type CodeOwnersRule,
} from '../src/parse'

describe('replaceCodeOwnersPatternToGlobs', () => {
  test('wildcard patterns', () => {
    expect(replaceCodeOwnersPatternToGlobs('*')).toEqual(['**'])
    expect(replaceCodeOwnersPatternToGlobs('**')).toEqual(['**'])
  })

  test('leading slash matches root only', () => {
    expect(replaceCodeOwnersPatternToGlobs('/src')).toEqual(['src', 'src/**'])
  })

  test('trailing slash matches as directory', () => {
    expect(replaceCodeOwnersPatternToGlobs('/docs/')).toEqual(['docs/**'])
    expect(replaceCodeOwnersPatternToGlobs('build/')).toEqual(['**/build/**'])
  })

  test('pattern without slash matches anywhere', () => {
    expect(replaceCodeOwnersPatternToGlobs('*.ts')).toEqual(['**/*.ts'])
  })

  test('pattern with middle slash matches relative to root', () => {
    expect(replaceCodeOwnersPatternToGlobs('src/utils')).toEqual(['src/utils', 'src/utils/**'])
  })

  test('pattern with extension treated as file', () => {
    expect(replaceCodeOwnersPatternToGlobs('/src/main.ts')).toEqual(['src/main.ts'])
  })

  test('trailing wildcard treated as file pattern', () => {
    expect(replaceCodeOwnersPatternToGlobs('/src/*')).toEqual(['src/*'])
    expect(replaceCodeOwnersPatternToGlobs('/src/**')).toEqual(['src/**'])
  })

  test('dotfile without extension matches as file or directory', () => {
    expect(replaceCodeOwnersPatternToGlobs('.github')).toEqual(['**/.github', '**/.github/**'])
  })
})

describe('parseCodeOwners', () => {
  test('parses user owners', () => {
    const result = parseCodeOwners('* @alice @bob')
    expect(result).toEqual([
      {
        glob: '**',
        owners: [
          { kind: 'user', name: 'alice' },
          { kind: 'user', name: 'bob' },
        ],
      },
    ])
  })

  test('parses team owners', () => {
    const result = parseCodeOwners('/src/ @org/team-a')
    expect(result).toEqual([
      {
        glob: 'src/**',
        owners: [{ kind: 'team', name: 'org/team-a', org: 'org', team: 'team-a' }],
      },
    ])
  })

  test('skips blank lines', () => {
    const result = parseCodeOwners('* @alice\n\n/docs/ @bob')
    expect(result).toHaveLength(2)
  })

  test('expands patterns to multiple globs', () => {
    const result = parseCodeOwners('/src @alice')
    expect(result).toEqual([
      { glob: 'src', owners: [{ kind: 'user', name: 'alice' }] },
      { glob: 'src/**', owners: [{ kind: 'user', name: 'alice' }] },
    ])
  })

  test('throws on invalid owner format', () => {
    expect(() => parseCodeOwners('* invalid-owner')).toThrow('Invalid owner format.')
  })
})

describe('getFileOwners', () => {
  test('matches files to owners using last matching rule', () => {
    const rules: CodeOwnersRule[] = [
      { glob: '**', owners: [{ kind: 'user', name: 'alice' }] },
      { glob: 'src/**', owners: [{ kind: 'user', name: 'bob' }] },
    ]
    const result = getFileOwners(['src/main.ts', 'README.md'], rules)
    expect(result).toEqual([
      { filename: 'src/main.ts', owners: [{ kind: 'user', name: 'bob' }] },
      { filename: 'README.md', owners: [{ kind: 'user', name: 'alice' }] },
    ])
  })

  test('returns empty owners when no rule matches', () => {
    const rules: CodeOwnersRule[] = [{ glob: 'src/**', owners: [{ kind: 'user', name: 'alice' }] }]
    const result = getFileOwners(['README.md'], rules)
    expect(result).toEqual([{ filename: 'README.md', owners: [] }])
  })
})

describe('listUniqueOwners', () => {
  test('deduplicates owners by name', () => {
    const alice = { kind: 'user' as const, name: 'alice' }
    const bob = { kind: 'user' as const, name: 'bob' }
    const result = listUniqueOwners([
      { filename: 'a.ts', owners: [alice, bob] },
      { filename: 'b.ts', owners: [alice] },
    ])
    expect(result).toEqual([alice, bob])
  })

  test('returns empty array when no owners', () => {
    const result = listUniqueOwners([{ filename: 'a.ts', owners: [] }])
    expect(result).toEqual([])
  })
})
