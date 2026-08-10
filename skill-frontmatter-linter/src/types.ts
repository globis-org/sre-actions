export interface Finding {
  path: string
  line: number
  level: 'error' | 'warning' | 'pass'
  title: string
  message: string
}

export interface TargetFile {
  path: string
  kind: 'skill' | 'command'
}

export interface PolicyConfig {
  claudeSkillsDirs: string[]
  claudeCommandsDirs: string[]
  pluginRoots: string[]
  requiredFields: string[]
  skillRequiredFields: string[]
  allowUnknownFields: boolean
  directoryMustMatchName: boolean
  namePattern: string
  maxNameLength: number
  allowedTools: string[] | null
  requireJustification: string[]
}
