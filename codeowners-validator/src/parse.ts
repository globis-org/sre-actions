import { minimatch } from 'minimatch'

export type CodeOwnersRule = {
  glob: string
  owners: Owner[]
}

export type FileOwners = {
  filename: string
  owners: Owner[]
}

export type Owner = User | Team

type User = {
  kind: 'user'
  name: string
}

type Team = {
  kind: 'team'
  name: string
  org: string
  team: string
}

// Convert CODEOWNERS pattern to minimatch globs
export const replaceCodeOwnersPatternToGlobs = (pattern: string): string[] => {
  let glob = pattern
  const leadingSlash = pattern.startsWith('/')
  const middleSlash = pattern.slice(1, -1).includes('/')
  const trailingSlash = pattern.endsWith('/')
  const trailingWildcards = pattern.endsWith('/*') || pattern.endsWith('/**')
  const basename = pattern.split('/').at(-1) || ''
  const hasExtension = basename.includes('.') && !basename.startsWith('.') // exclude '.gitignore' pattern

  if (glob === '*' || glob === '**') {
    return ['**']
  }

  if (leadingSlash) {
    glob = glob.slice(1) // only root dir
  } else if (!middleSlash) {
    glob = '**/' + glob // anywhere in repository
  }

  if (trailingSlash) {
    return [glob + '**'] // as directory
  } else if (hasExtension || trailingWildcards) {
    return [glob] // as file
  }
  return [glob, glob + '/**'] // as file or directory
}

export const parseCodeOwners = (codeowners: string): CodeOwnersRule[] => {
  const lines = codeowners
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return lines.flatMap(line => {
    const [pattern, ...rawOwners] = line.split(/\s+/)
    const globs = replaceCodeOwnersPatternToGlobs(pattern)

    const ownerRegex = /^@(.+)$/
    const owners = rawOwners.map((rawOwner): User | Team => {
      const match = rawOwner.match(ownerRegex)
      if (!match) {
        throw new Error('Invalid owner format.')
      }
      const owner = match[1]
      if (owner.includes('/')) {
        const [org, team] = owner.split('/')
        return { kind: 'team', org, team, name: owner }
      } else {
        return { kind: 'user', name: owner }
      }
    })

    return globs.map(glob => ({ glob, owners }))
  })
}

export const getFileOwners = (
  diffFiles: string[],
  rules: CodeOwnersRule[]
): FileOwners[] => {
  const reversedRules = rules.reverse()
  const fileOwners = diffFiles.map(filename => {
    const matchedRule = reversedRules.find(rule =>
      minimatch(filename, rule.glob, { dot: true })
    )
    const owners = matchedRule?.owners || []
    return { filename, owners }
  })
  return fileOwners
}

export const listUniqueOwners = (fileOwners: FileOwners[]): Owner[] => {
  const owners = fileOwners.flatMap(fileOwner => fileOwner.owners)
  const uniqueOwnersMap = new Map(owners.map(owner => [owner.name, owner]))
  return [...uniqueOwnersMap.values()]
}
