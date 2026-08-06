import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, basename, dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Finding, TargetFile, PolicyConfig } from './types'
import { loadConfig } from './config'

const BARE_BASH_RE = /(?:^|,)\s*Bash\s*(?:,|$)/
const MCP_FUNC_RE = /(?:^|,)\s*MCP\(/
const BASH_SPEC_RE = /Bash\(([^)]*)\)/g

// https://code.claude.com/docs/en/skills#frontmatter-reference
const KNOWN_FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
])

export function discoverFiles(root: string, cfg: PolicyConfig): TargetFile[] {
  const targets: TargetFile[] = []

  for (const dir of cfg.claudeSkillsDirs) {
    const base = join(root, dir)
    if (!isDir(base)) continue
    for (const entry of sortedDirEntries(base)) {
      const skillFile = join(base, entry, 'SKILL.md')
      if (isDir(join(base, entry)) && existsSync(skillFile)) {
        targets.push({ path: skillFile, kind: 'skill' })
      }
    }
  }

  for (const dir of cfg.claudeCommandsDirs) {
    const base = join(root, dir)
    if (!isDir(base)) continue
    collectCommandFiles(base, targets)
  }

  for (const pluginRoot of cfg.pluginRoots) {
    const base = join(root, pluginRoot)
    if (!isDir(base)) continue
    for (const pluginName of sortedDirEntries(base)) {
      const pluginDir = join(base, pluginName)
      if (!isDir(pluginDir)) continue

      const skillsBase = join(pluginDir, 'skills')
      if (isDir(skillsBase)) {
        for (const skillName of sortedDirEntries(skillsBase)) {
          const skillFile = join(skillsBase, skillName, 'SKILL.md')
          if (isDir(join(skillsBase, skillName)) && existsSync(skillFile)) {
            targets.push({ path: skillFile, kind: 'skill' })
          }
        }
      }

      const commandsBase = join(pluginDir, 'commands')
      if (isDir(commandsBase)) {
        collectCommandFiles(commandsBase, targets)
      }
    }
  }

  return targets
}

function collectCommandFiles(dir: string, targets: TargetFile[]): void {
  for (const entry of sortedDirEntries(dir)) {
    const full = join(dir, entry)
    if (isDir(full)) {
      collectCommandFiles(full, targets)
    } else if (entry.endsWith('.md')) {
      targets.push({ path: full, kind: 'command' })
    }
  }
}

export function parseFrontmatter(
  content: string
): { fm: Record<string, unknown>; endLine: number } | { error: string } {
  const lines = content.split('\n')

  if (!lines.length || lines[0]!.trim() !== '---') {
    return { error: 'no YAML frontmatter found' }
  }

  let endIdx: number | null = null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      endIdx = i
      break
    }
  }

  if (endIdx === null) {
    return { error: 'frontmatter not closed (missing closing ---)' }
  }

  const fmText = lines.slice(1, endIdx).join('\n')
  let parsed: unknown
  try {
    parsed = parseYaml(fmText)
  } catch (e) {
    return { error: `YAML parse error: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (parsed === null || parsed === undefined) {
    return { fm: {}, endLine: endIdx + 1 }
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'frontmatter is not a mapping' }
  }

  return { fm: parsed as Record<string, unknown>, endLine: endIdx + 1 }
}

export function extractToolNames(toolsStr: string): string[] {
  const names: string[] = []
  let rest = toolsStr

  while (rest.length > 0) {
    rest = rest.replace(/^[\s,]+/, '')
    if (!rest) break

    const parenIdx = rest.indexOf('(')
    const commaIdx = rest.indexOf(',')

    if (parenIdx !== -1 && (commaIdx === -1 || parenIdx < commaIdx)) {
      const name = rest.slice(0, parenIdx).trim()
      const closeIdx = rest.indexOf(')', parenIdx)
      if (name) names.push(name)
      rest = closeIdx === -1 ? '' : rest.slice(closeIdx + 1)
    } else if (commaIdx !== -1) {
      const name = rest.slice(0, commaIdx).trim()
      if (name) names.push(name)
      rest = rest.slice(commaIdx + 1)
    } else {
      const name = rest.trim()
      if (name) names.push(name)
      break
    }
  }

  return names
}

export function checkAllowedToolsSpecifiers(toolsStr: string, relPath: string): Finding[] {
  const findings: Finding[] = []

  if (BARE_BASH_RE.test(toolsStr)) {
    findings.push({
      path: relPath,
      line: 1,
      level: 'error',
      title: 'Broad Bash permission',
      message: 'bare Bash allows all commands; use Bash(<command>:*) to specify',
    })
  }

  if (MCP_FUNC_RE.test(toolsStr)) {
    findings.push({
      path: relPath,
      line: 1,
      level: 'error',
      title: 'Invalid MCP format',
      message: 'MCP(...) format is invalid; use mcp__<server> or mcp__<server>__<tool>',
    })
  }

  for (const m of toolsStr.matchAll(BASH_SPEC_RE)) {
    const inner = m[1]!

    if (inner === '' || inner === ':*') {
      findings.push({
        path: relPath,
        line: 1,
        level: 'error',
        title: 'Invalid Bash specifier',
        message: `Bash(${inner}) is not a valid specifier`,
      })
      continue
    }

    if (inner.includes(',')) {
      findings.push({
        path: relPath,
        line: 1,
        level: 'error',
        title: 'Comma in Bash specifier',
        message: `Bash(${inner}) uses comma-separated specifiers which is invalid; split into separate Bash() entries`,
      })
      continue
    }

    if (inner === '*' || inner === '*:*') {
      findings.push({
        path: relPath,
        line: 1,
        level: 'error',
        title: 'Broad Bash permission',
        message: `Bash(${inner}) allows all commands; specify commands explicitly`,
      })
      continue
    }

    if (inner.endsWith(':*')) {
      const prefix = inner.slice(0, -2)
      if (prefix.includes('*')) {
        findings.push({
          path: relPath,
          line: 1,
          level: 'error',
          title: 'Glob with colon-star',
          message: `Bash(${inner}) combines glob with :* which never matches; use "Bash(${prefix} *)" (space + *) to allow arguments`,
        })
      }
    }
  }

  const unclosed = toolsStr.match(/\w+\([^)]*(?:,|$)/g)
  if (unclosed) {
    for (const m of unclosed) {
      const name = m.replace(/\(.*/, '')
      findings.push({
        path: relPath,
        line: 1,
        level: 'error',
        title: 'Unclosed parenthesis',
        message: `${name}( is missing closing )`,
      })
    }
  }

  return findings
}

export function checkUnclosedCodeFences(content: string, relPath: string): Finding[] {
  const findings: Finding[] = []
  const lines = content.split('\n')

  let bodyStart = 0
  if (lines.length && lines[0]!.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === '---') {
        bodyStart = i + 1
        break
      }
    }
  }

  const fenceStack: Array<{ line: number; count: number }> = []
  const fenceRe = /^(`{3,})/

  for (let i = bodyStart; i < lines.length; i++) {
    const stripped = lines[i]!.trim()
    const m = fenceRe.exec(stripped)
    if (!m) continue

    const count = m[1]!.length
    const isCloser = stripped === m[1]

    if (fenceStack.length > 0) {
      if (isCloser && count >= fenceStack[fenceStack.length - 1]!.count) {
        fenceStack.pop()
      }
    } else {
      fenceStack.push({ line: i + 1, count })
    }
  }

  for (const { line } of fenceStack) {
    findings.push({
      path: relPath,
      line,
      level: 'error',
      title: 'Unclosed code fence',
      message: `code fence opened at line ${String(line)} is never closed`,
    })
  }

  return findings
}

function normalizeAllowedTools(
  value: unknown,
  relPath: string,
  findings: Finding[],
): string {
  if (Array.isArray(value)) {
    return value.map(String).join(', ')
  }
  const str = String(value)
  if (str.includes('\n')) {
    findings.push({
      path: relPath,
      line: 1,
      level: 'warning',
      title: 'Unsupported allowed-tools format',
      message:
        'block scalar (|) in allowed-tools is not officially supported; use a space/comma-separated string or a YAML list',
    })
  }
  return normalizeSpaceSeparated(str)
}

export function normalizeSpaceSeparated(str: string): string {
  if (str.includes(',')) return str

  const tokens: string[] = []
  let rest = str.replace(/\n/g, ' ').trim()
  while (rest.length > 0) {
    const parenIdx = rest.indexOf('(')
    const spaceIdx = rest.indexOf(' ')

    if (parenIdx !== -1 && (spaceIdx === -1 || parenIdx < spaceIdx)) {
      const closeIdx = rest.indexOf(')', parenIdx)
      if (closeIdx === -1) {
        tokens.push(rest)
        break
      }
      tokens.push(rest.slice(0, closeIdx + 1))
      rest = rest.slice(closeIdx + 1).trim()
    } else if (spaceIdx !== -1) {
      const token = rest.slice(0, spaceIdx)
      if (token) tokens.push(token)
      rest = rest.slice(spaceIdx + 1).trim()
    } else {
      tokens.push(rest)
      break
    }
  }
  return tokens.join(', ')
}

export function checkFile(target: TargetFile, root: string, cfg: PolicyConfig): Finding[] {
  const findings: Finding[] = []
  const relPath = relative(root, target.path)

  let content: string
  try {
    content = readFileSync(target.path, 'utf-8')
  } catch (e) {
    findings.push({
      path: relPath,
      line: 1,
      level: 'error',
      title: 'Read error',
      message: `failed to read file: ${e instanceof Error ? e.message : String(e)}`,
    })
    return findings
  }

  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  }

  findings.push({
    path: relPath,
    line: 1,
    level: 'pass',
    title: 'file found',
    message: '',
  })

  const result = parseFrontmatter(content)

  if ('error' in result) {
    findings.push({
      path: relPath,
      line: 1,
      level: 'error',
      title: 'Invalid frontmatter',
      message: result.error,
    })
    findings.push(...checkUnclosedCodeFences(content, relPath))
    return findings
  }

  const { fm } = result

  findings.push({
    path: relPath,
    line: 1,
    level: 'pass',
    title: 'frontmatter parsed',
    message: '',
  })

  const required = [
    ...cfg.requiredFields,
    ...(target.kind === 'skill' ? cfg.skillRequiredFields : []),
  ]

  for (const field of required) {
    if (!(field in fm) || !fm[field]) {
      findings.push({
        path: relPath,
        line: 1,
        level: 'error',
        title: 'Missing required field',
        message: `missing required field: ${field}`,
      })
    }
  }

  if (target.kind === 'skill') {
    const rawName = fm['name']
    const skillDirName = basename(dirname(target.path))

    if (rawName !== undefined && rawName !== null && rawName !== '') {
      if (typeof rawName !== 'string') {
        findings.push({
          path: relPath,
          line: 1,
          level: 'error',
          title: 'Invalid name type',
          message: `name must be a string, got ${typeof rawName}`,
        })
      } else {
        const nameRe = new RegExp(cfg.namePattern)
        if (!nameRe.test(rawName)) {
          findings.push({
            path: relPath,
            line: 1,
            level: 'error',
            title: 'Invalid name format',
            message: `name '${rawName}' does not match pattern ${cfg.namePattern}`,
          })
        }

        if (rawName.length > cfg.maxNameLength) {
          findings.push({
            path: relPath,
            line: 1,
            level: 'error',
            title: 'Name too long',
            message: `name '${rawName}' exceeds max length ${String(cfg.maxNameLength)}`,
          })
        }

        if (cfg.directoryMustMatchName && rawName !== skillDirName) {
          findings.push({
            path: relPath,
            line: 1,
            level: 'error',
            title: 'Directory name mismatch',
            message: `skill name '${rawName}' does not match directory '${skillDirName}'`,
          })
        }
      }
    }
  }

  if (!cfg.allowUnknownFields) {
    const unknown = Object.keys(fm).filter(k => !KNOWN_FRONTMATTER_FIELDS.has(k))
    if (unknown.length > 0) {
      findings.push({
        path: relPath,
        line: 1,
        level: 'warning',
        title: 'Unknown frontmatter fields',
        message: `unknown fields: ${unknown.toSorted().join(', ')}`,
      })
    }
  }

  const allowedToolsRaw = fm['allowed-tools']
  if (allowedToolsRaw) {
    const toolsStr = normalizeAllowedTools(allowedToolsRaw, relPath, findings)

    findings.push(...checkAllowedToolsSpecifiers(toolsStr, relPath))

    if (cfg.allowedTools !== null) {
      const toolNames = extractToolNames(toolsStr)
      const disallowed = toolNames.filter(
        t => !cfg.allowedTools!.includes(t) && !t.startsWith('mcp__')
      )
      if (disallowed.length > 0) {
        findings.push({
          path: relPath,
          line: 1,
          level: 'error',
          title: 'Disallowed tools',
          message: `tools not in allowed list: ${disallowed.join(', ')}`,
        })
      }
    }

    for (const tool of cfg.requireJustification) {
      const toolNames = extractToolNames(toolsStr)
      if (toolNames.includes(tool)) {
        const description = fm['description']
        if (
          typeof description === 'string' &&
          !description.toLowerCase().includes(tool.toLowerCase())
        ) {
          findings.push({
            path: relPath,
            line: 1,
            level: 'warning',
            title: 'Tool justification missing',
            message: `tool '${tool}' requires justification in description`,
          })
        }
      }
    }
  }

  findings.push(...checkUnclosedCodeFences(content, relPath))

  return findings
}

export function formatText(allFindings: Map<string, Finding[]>): string {
  const lines = ['Skill frontmatter lint', '']

  for (const [key, findings] of allFindings) {
    lines.push(`  ${key}`)
    for (const f of findings) {
      if (f.level === 'pass') lines.push(`    ✓ ${f.title}`)
      else if (f.level === 'error') lines.push(`    ✗ ${f.message}`)
      else if (f.level === 'warning') lines.push(`    ! ${f.message}`)
    }
    lines.push('')
  }

  let errors = 0
  let warnings = 0
  for (const findings of allFindings.values()) {
    for (const f of findings) {
      if (f.level === 'error') errors++
      else if (f.level === 'warning') warnings++
    }
  }

  lines.push('Summary')
  lines.push(`  ${String(errors)} error${errors !== 1 ? 's' : ''}`)
  lines.push(`  ${String(warnings)} warning${warnings !== 1 ? 's' : ''}`)

  return lines.join('\n')
}

function escapeGitHubAnnotation(s: string): string {
  return s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export function formatGitHub(allFindings: Map<string, Finding[]>): string {
  const lines: string[] = []
  for (const findings of allFindings.values()) {
    for (const f of findings) {
      if (f.level === 'pass') continue
      const kind = f.level === 'error' ? 'error' : 'warning'
      const msg = escapeGitHubAnnotation(f.message)
      const title = escapeGitHubAnnotation(f.title)
      lines.push(`::${kind} file=${f.path},line=${String(f.line)},title=${title}::${msg}`)
    }
  }
  return lines.join('\n')
}

export function formatJson(allFindings: Map<string, Finding[]>): string {
  const output: Record<string, Array<Omit<Finding, 'level'> & { level: string }>> = {}
  for (const [key, findings] of allFindings) {
    output[key] = findings
      .filter(f => f.level !== 'pass')
      .map(f => ({
        path: f.path,
        line: f.line,
        level: f.level,
        title: f.title,
        message: f.message,
      }))
  }
  return JSON.stringify(output, null, 2)
}

export function run(options: {
  path: string
  config: string
  format: 'text' | 'github' | 'json'
  strict: boolean
}): { output: string; hasErrors: boolean } {
  const root = resolve(options.path)
  const configPath = resolve(root, options.config)

  const cfg = loadConfig(configPath)
  const targets = discoverFiles(root, cfg)

  if (targets.length === 0) {
    return {
      output: 'No skill or command files found',
      hasErrors: true,
    }
  }

  const allFindings = new Map<string, Finding[]>()

  for (const target of targets) {
    const key =
      target.kind === 'skill' ? relative(root, dirname(target.path)) : relative(root, target.path)
    allFindings.set(key, checkFile(target, root, cfg))
  }

  let output: string
  if (options.format === 'github') {
    output = formatGitHub(allFindings)
  } else if (options.format === 'json') {
    output = formatJson(allFindings)
  } else {
    output = formatText(allFindings)
  }

  let hasErrors = false
  for (const findings of allFindings.values()) {
    for (const f of findings) {
      if (f.level === 'error') hasErrors = true
      if (options.strict && f.level === 'warning') hasErrors = true
    }
  }

  return { output, hasErrors }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function sortedDirEntries(dir: string): string[] {
  return readdirSync(dir).toSorted()
}
