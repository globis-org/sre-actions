import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseFrontmatter,
  extractToolNames,
  checkAllowedToolsSpecifiers,
  checkUnclosedCodeFences,
  checkFile,
  discoverFiles,
  normalizeSpaceSeparated,
  formatGitHub,
} from '../src/checker'
import { loadConfig } from '../src/config'
import type { PolicyConfig, TargetFile } from '../src/types'

function defaultConfig(): PolicyConfig {
  return loadConfig('/nonexistent')
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spc-test-'))
}

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const result = parseFrontmatter('---\nname: foo\n---\nbody')
    expect(result).toEqual({ fm: { name: 'foo' }, endLine: 3 })
  })

  it('returns error for no frontmatter', () => {
    const result = parseFrontmatter('# Just markdown')
    expect(result).toEqual({ error: 'no YAML frontmatter found' })
  })

  it('returns error for unclosed frontmatter', () => {
    const result = parseFrontmatter('---\nname: foo\nbody')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('not closed')
  })

  it('returns error for non-mapping', () => {
    const result = parseFrontmatter('---\n- a\n- b\n---\n')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('not a mapping')
  })

  it('handles empty frontmatter', () => {
    const result = parseFrontmatter('---\n---\nbody')
    expect(result).toEqual({ fm: {}, endLine: 2 })
  })

  it('returns error for invalid YAML', () => {
    const result = parseFrontmatter('---\n: bad: yaml: {{{\n---\n')
    expect(result).toHaveProperty('error')
  })
})

// ---------------------------------------------------------------------------
// extractToolNames
// ---------------------------------------------------------------------------

describe('extractToolNames', () => {
  it('extracts simple names', () => {
    expect(extractToolNames('Read, Grep, Glob')).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('extracts Bash with specifier', () => {
    expect(extractToolNames('Bash(git:*), Read')).toEqual(['Bash', 'Read'])
  })

  it('extracts multiple Bash entries', () => {
    expect(extractToolNames('Bash(git:*), Bash(terraform:*), Read')).toEqual([
      'Bash',
      'Bash',
      'Read',
    ])
  })

  it('handles mcp__ tools', () => {
    expect(extractToolNames('mcp__server__tool, Read')).toEqual(['mcp__server__tool', 'Read'])
  })

  it('handles comma inside parens', () => {
    expect(extractToolNames('Bash(git:*,terraform:*), Read')).toEqual(['Bash', 'Read'])
  })

  it('returns empty for empty string', () => {
    expect(extractToolNames('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// normalizeSpaceSeparated
// ---------------------------------------------------------------------------

describe('normalizeSpaceSeparated', () => {
  it('converts space-separated tools to comma-separated', () => {
    expect(normalizeSpaceSeparated('Read Grep Glob')).toBe('Read, Grep, Glob')
  })

  it('preserves spaces inside Bash()', () => {
    expect(normalizeSpaceSeparated('Bash(git add *) Read')).toBe('Bash(git add *), Read')
  })

  it('passes through comma-separated strings unchanged', () => {
    expect(normalizeSpaceSeparated('Read, Grep')).toBe('Read, Grep')
  })

  it('handles Bash specifiers with spaces between them', () => {
    expect(normalizeSpaceSeparated('Bash(git:*) Bash(terraform:*) Read')).toBe(
      'Bash(git:*), Bash(terraform:*), Read'
    )
  })

  it('handles single tool', () => {
    expect(normalizeSpaceSeparated('Read')).toBe('Read')
  })

  it('handles newline-separated (YAML block scalar)', () => {
    expect(normalizeSpaceSeparated('Bash(git:*)\nRead\nGrep\n')).toBe('Bash(git:*), Read, Grep')
  })
})

// ---------------------------------------------------------------------------
// checkAllowedToolsSpecifiers
// ---------------------------------------------------------------------------

describe('checkAllowedToolsSpecifiers', () => {
  it('passes valid specifiers', () => {
    expect(checkAllowedToolsSpecifiers('Bash(git:*), Read', 't.md')).toEqual([])
  })

  it('detects comma-separated Bash', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(git:*,terraform:*), Read', 't.md')
    expect(findings.some(f => f.message.includes('comma-separated'))).toBe(true)
  })

  it('detects bare Bash', () => {
    const findings = checkAllowedToolsSpecifiers('Bash, Read', 't.md')
    expect(findings.some(f => f.message.includes('bare Bash'))).toBe(true)
  })

  it('detects bare Bash at end', () => {
    const findings = checkAllowedToolsSpecifiers('Read, Bash', 't.md')
    expect(findings.some(f => f.message.includes('bare Bash'))).toBe(true)
  })

  it('detects bare Bash in space-separated format', () => {
    const findings = checkAllowedToolsSpecifiers('Read, Bash, Grep', 't.md')
    expect(findings.some(f => f.message.includes('bare Bash'))).toBe(true)
  })

  it('detects Bash(*)', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(*), Read', 't.md')
    expect(findings.some(f => f.message.includes('Bash(*) allows all'))).toBe(true)
  })

  it('detects Bash(*:*)', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(*:*), Read', 't.md')
    expect(findings.some(f => f.message.includes('Bash(*:*) allows all'))).toBe(true)
  })

  it('detects glob with :*', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(*/deploy.sh:*), Read', 't.md')
    expect(findings.some(f => f.title === 'Glob with colon-star')).toBe(true)
  })

  it('detects MCP function format', () => {
    const findings = checkAllowedToolsSpecifiers('MCP(server:*), Read', 't.md')
    expect(findings.some(f => f.message.includes('MCP'))).toBe(true)
  })

  it('passes valid Bash specifiers', () => {
    expect(checkAllowedToolsSpecifiers('Bash(git push:*), Read', 't.md')).toEqual([])
    expect(checkAllowedToolsSpecifiers('Bash(terraform:*), Read', 't.md')).toEqual([])
  })

  it('no false positive on space star', () => {
    expect(checkAllowedToolsSpecifiers('Bash(*/deploy.sh *), Read', 't.md')).toEqual([])
  })

  it('detects empty Bash()', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(), Read', 't.md')
    expect(findings.some(f => f.title === 'Invalid Bash specifier')).toBe(true)
  })

  it('detects Bash(:*)', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(:*), Read', 't.md')
    expect(findings.some(f => f.title === 'Invalid Bash specifier')).toBe(true)
  })

  it('detects unclosed parenthesis', () => {
    const findings = checkAllowedToolsSpecifiers('Bash(git:*, Read', 't.md')
    expect(findings.some(f => f.title === 'Unclosed parenthesis')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// checkUnclosedCodeFences
// ---------------------------------------------------------------------------

describe('checkUnclosedCodeFences', () => {
  it('passes valid fences', () => {
    expect(checkUnclosedCodeFences('---\nname: x\n---\n```bash\necho hi\n```\n', 't.md')).toEqual(
      []
    )
  })

  it('detects unclosed fences', () => {
    const findings = checkUnclosedCodeFences('---\nname: x\n---\n```bash\necho hi\n', 't.md')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.level).toBe('error')
  })

  it('passes no fences', () => {
    expect(checkUnclosedCodeFences('no fences here', 't.md')).toEqual([])
  })

  it('handles 4-backtick fences wrapping 3-backtick examples', () => {
    const content = [
      '---',
      'name: x',
      '---',
      '````markdown',
      '```bash',
      'echo hi',
      '```',
      '````',
    ].join('\n')
    expect(checkUnclosedCodeFences(content, 't.md')).toEqual([])
  })

  it('detects unclosed 4-backtick fence', () => {
    const content = ['---', 'name: x', '---', '````markdown', '```bash', 'echo hi', '```'].join(
      '\n'
    )
    const findings = checkUnclosedCodeFences(content, 't.md')
    expect(findings).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// checkFile (skill)
// ---------------------------------------------------------------------------

describe('checkFile (skill)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeSkill(name: string, content: string): TargetFile {
    const dir = join(tmp, '.claude', 'skills', name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, content)
    return { path: file, kind: 'skill' }
  }

  it('passes valid skill', () => {
    const target = makeSkill(
      'deploy-app',
      '---\nname: deploy-app\ndescription: Deploys app\nallowed-tools: Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors).toEqual([])
  })

  it('detects missing name', () => {
    const target = makeSkill('my-skill', '---\ndescription: Stuff\nallowed-tools: Read\n---\n')
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('name'))).toBe(true)
  })

  it('detects missing description', () => {
    const target = makeSkill('my-skill', '---\nname: my-skill\nallowed-tools: Read\n---\n')
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('description'))).toBe(true)
  })

  it('detects missing allowed-tools', () => {
    const target = makeSkill('my-skill', '---\nname: my-skill\ndescription: Stuff\n---\n')
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('allowed-tools'))).toBe(true)
  })

  it('detects non-kebab name', () => {
    const target = makeSkill(
      'MySkill',
      '---\nname: MySkill\ndescription: Stuff\nallowed-tools: Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('does not match pattern'))).toBe(true)
  })

  it('detects directory name mismatch', () => {
    const target = makeSkill(
      'wrong-dir',
      '---\nname: correct-name\ndescription: Stuff\nallowed-tools: Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('does not match directory'))).toBe(true)
  })

  it('detects comma-separated Bash', () => {
    const target = makeSkill(
      'my-skill',
      '---\nname: my-skill\ndescription: Stuff\nallowed-tools: Bash(git:*,terraform:*), Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('comma-separated'))).toBe(true)
  })

  it('detects non-string name (e.g. integer)', () => {
    const target = makeSkill(
      'my-skill',
      '---\nname: 2024\ndescription: Stuff\nallowed-tools: Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('must be a string'))).toBe(true)
  })

  it('detects unknown fields', () => {
    const target = makeSkill(
      'my-skill',
      '---\nname: my-skill\ndescription: Stuff\nallowed-tools: Read\nunknown-field: val\n---\n'
    )
    const warnings = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'warning')
    expect(warnings.some(f => f.message.includes('unknown fields'))).toBe(true)
  })

  it('handles BOM', () => {
    const target = makeSkill(
      'my-skill',
      '﻿---\nname: my-skill\ndescription: Stuff\nallowed-tools: Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkFile (command)
// ---------------------------------------------------------------------------

describe('checkFile (command)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeCommand(name: string, content: string): TargetFile {
    const dir = join(tmp, '.claude', 'commands')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, content)
    return { path: file, kind: 'command' }
  }

  it('passes valid command', () => {
    const target = makeCommand(
      'deploy.md',
      '---\ndescription: Deploys app\nallowed-tools: Bash(git:*), Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors).toEqual([])
  })

  it('does not require name for commands', () => {
    const target = makeCommand(
      'deploy.md',
      '---\ndescription: Deploys app\nallowed-tools: Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.every(f => !f.message.includes('name'))).toBe(true)
  })

  it('detects missing description', () => {
    const target = makeCommand('deploy.md', '---\nallowed-tools: Read\n---\n')
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('description'))).toBe(true)
  })

  it('detects missing allowed-tools', () => {
    const target = makeCommand('deploy.md', '---\ndescription: Deploys\n---\n')
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('allowed-tools'))).toBe(true)
  })

  it('detects bare Bash', () => {
    const target = makeCommand(
      'deploy.md',
      '---\ndescription: Deploys\nallowed-tools: Bash, Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('bare Bash'))).toBe(true)
  })

  it('detects MCP function format', () => {
    const target = makeCommand(
      'deploy.md',
      '---\ndescription: Deploys\nallowed-tools: MCP(server:*), Read\n---\n'
    )
    const errors = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'error')
    expect(errors.some(f => f.message.includes('MCP'))).toBe(true)
  })

  it('warns on block scalar allowed-tools', () => {
    const target = makeCommand(
      'deploy.md',
      '---\ndescription: Deploys\nallowed-tools: |\n  Bash(git:*)\n  Read\n---\n'
    )
    const warnings = checkFile(target, tmp, defaultConfig()).filter(f => f.level === 'warning')
    expect(warnings.some(f => f.message.includes('block scalar'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// discoverFiles
// ---------------------------------------------------------------------------

describe('discoverFiles', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('discovers skills and commands', () => {
    mkdirSync(join(tmp, '.claude', 'skills', 'my-skill'), { recursive: true })
    writeFileSync(
      join(tmp, '.claude', 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\n---\n'
    )
    mkdirSync(join(tmp, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(tmp, '.claude', 'commands', 'deploy.md'), '---\ndescription: x\n---\n')

    const targets = discoverFiles(tmp, defaultConfig())
    expect(targets).toHaveLength(2)
    expect(new Set(targets.map(t => t.kind))).toEqual(new Set(['skill', 'command']))
  })

  it('discovers plugin skills and commands', () => {
    mkdirSync(join(tmp, 'claude-plugins', 'my-plugin', 'skills', 'review'), { recursive: true })
    writeFileSync(
      join(tmp, 'claude-plugins', 'my-plugin', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\n---\n'
    )
    mkdirSync(join(tmp, 'claude-plugins', 'my-plugin', 'commands'), { recursive: true })
    writeFileSync(
      join(tmp, 'claude-plugins', 'my-plugin', 'commands', 'deploy.md'),
      '---\ndescription: x\n---\n'
    )

    const targets = discoverFiles(tmp, defaultConfig())
    expect(targets).toHaveLength(2)
  })

  it('discovers nested commands', () => {
    mkdirSync(join(tmp, '.claude', 'commands', 'sub'), { recursive: true })
    writeFileSync(join(tmp, '.claude', 'commands', 'top.md'), 'x')
    writeFileSync(join(tmp, '.claude', 'commands', 'sub', 'nested.md'), 'x')

    const targets = discoverFiles(tmp, defaultConfig())
    expect(targets).toHaveLength(2)
    expect(targets.every(t => t.kind === 'command')).toBe(true)
  })

  it('ignores non-md files', () => {
    mkdirSync(join(tmp, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(tmp, '.claude', 'commands', 'deploy.md'), 'x')
    writeFileSync(join(tmp, '.claude', 'commands', 'readme.txt'), 'x')

    const targets = discoverFiles(tmp, defaultConfig())
    expect(targets).toHaveLength(1)
  })

  it('returns empty for empty dir', () => {
    expect(discoverFiles(tmp, defaultConfig())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns defaults for missing file', () => {
    const cfg = loadConfig('/nonexistent/path.yaml')
    expect(cfg.requiredFields).toEqual(['description', 'allowed-tools'])
    expect(cfg.skillRequiredFields).toEqual(['name'])
  })

  it('loads full config', () => {
    const tmp = makeTmpDir()
    const file = join(tmp, 'policy.yaml')
    writeFileSync(
      file,
      [
        'version: 1',
        'discovery:',
        '  claudeSkills:',
        '    - src/skills',
        '  claudeCommands:',
        '    - src/commands',
        '  pluginRoots:',
        '    - plugins',
        'frontmatter:',
        '  required:',
        '    - description',
        '  skillRequired:',
        '    - name',
        '  allowUnknown: true',
        'naming:',
        '  directoryMustMatchName: false',
        "  namePattern: '^[a-z]+$'",
        '  maxNameLength: 32',
        'tools:',
        '  allowed:',
        '    - Read',
        '  requireJustification:',
        '    - Bash',
      ].join('\n')
    )

    const cfg = loadConfig(file)
    expect(cfg.claudeSkillsDirs).toEqual(['src/skills'])
    expect(cfg.claudeCommandsDirs).toEqual(['src/commands'])
    expect(cfg.pluginRoots).toEqual(['plugins'])
    expect(cfg.requiredFields).toEqual(['description'])
    expect(cfg.skillRequiredFields).toEqual(['name'])
    expect(cfg.allowUnknownFields).toBe(true)
    expect(cfg.directoryMustMatchName).toBe(false)
    expect(cfg.maxNameLength).toBe(32)
    expect(cfg.allowedTools).toEqual(['Read'])
    expect(cfg.requireJustification).toEqual(['Bash'])

    rmSync(tmp, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// formatGitHub
// ---------------------------------------------------------------------------

describe('formatGitHub', () => {
  it('escapes newlines and percent in messages', () => {
    const findings = new Map([
      [
        'test',
        [
          {
            path: 'test/SKILL.md',
            line: 1,
            level: 'error' as const,
            title: 'Parse error',
            message: 'bad yaml\nat line 1\n',
          },
        ],
      ],
    ])
    const output = formatGitHub(findings)
    expect(output).not.toContain('\n\n')
    expect(output).toContain('%0A')
    expect(output).toContain('bad yaml%0Aat line 1%0A')
  })

  it('escapes percent signs', () => {
    const findings = new Map([
      [
        'test',
        [
          {
            path: 'test/SKILL.md',
            line: 1,
            level: 'warning' as const,
            title: '100% done',
            message: '100% complete',
          },
        ],
      ],
    ])
    const output = formatGitHub(findings)
    expect(output).toContain('100%25 done')
    expect(output).toContain('100%25 complete')
  })
})
