import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { PolicyConfig } from './types'

const DEFAULT_CONFIG: PolicyConfig = {
  claudeSkillsDirs: ['.claude/skills'],
  claudeCommandsDirs: ['.claude/commands'],
  pluginRoots: ['claude-plugins'],
  requiredFields: ['description', 'allowed-tools'],
  skillRequiredFields: ['name'],
  allowUnknownFields: false,
  directoryMustMatchName: true,
  namePattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  maxNameLength: 64,
  allowedTools: null,
  requireJustification: [],
}

function getSection(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return (obj[key] ?? {}) as Record<string, unknown>
}

export function loadConfig(configPath: string): PolicyConfig {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG }
  }

  const raw = parseYaml(readFileSync(configPath, 'utf-8')) as
    | Record<string, unknown>
    | null
    | undefined

  if (!raw) {
    return { ...DEFAULT_CONFIG }
  }

  const cfg = { ...DEFAULT_CONFIG }

  const discovery = getSection(raw, 'discovery')
  if (Array.isArray(discovery['claudeSkills']))
    cfg.claudeSkillsDirs = discovery['claudeSkills'] as string[]
  if (Array.isArray(discovery['claudeCommands']))
    cfg.claudeCommandsDirs = discovery['claudeCommands'] as string[]
  if (Array.isArray(discovery['pluginRoots']))
    cfg.pluginRoots = discovery['pluginRoots'] as string[]

  const fm = getSection(raw, 'frontmatter')
  if (Array.isArray(fm['required'])) cfg.requiredFields = fm['required'] as string[]
  if (Array.isArray(fm['skillRequired'])) cfg.skillRequiredFields = fm['skillRequired'] as string[]
  if (typeof fm['allowUnknown'] === 'boolean') cfg.allowUnknownFields = fm['allowUnknown']

  const naming = getSection(raw, 'naming')
  if (typeof naming['directoryMustMatchName'] === 'boolean')
    cfg.directoryMustMatchName = naming['directoryMustMatchName']
  if (typeof naming['namePattern'] === 'string') cfg.namePattern = naming['namePattern']
  if (typeof naming['maxNameLength'] === 'number') cfg.maxNameLength = naming['maxNameLength']

  const tools = getSection(raw, 'tools')
  if (Array.isArray(tools['allowed'])) cfg.allowedTools = tools['allowed'] as string[]
  if (Array.isArray(tools['requireJustification']))
    cfg.requireJustification = tools['requireJustification'] as string[]

  return cfg
}
