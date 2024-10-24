import { minimatch } from 'minimatch'

export type CodeOwnersRule = {
  glob: string
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

export const parseCodeOwners = (codeowners: string): CodeOwnersRule[] => {
  const lines = codeowners.split('\n')
  if (lines.length > 1) {
    throw new Error('Multiple lines CODEOWNERS are not supported.')
  }

  return lines.map(line => {
    const [glob, ...rawOwners] = line.split(/\s+/)

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

    return { glob, owners }
  })
}

export const getFileOwners = (
  diffFiles: string[],
  rules: CodeOwnersRule[]
): Owner[] => {
  const reversedRules = rules.reverse()
  const fileOwners = diffFiles.flatMap(filename => {
    const matchedRule = reversedRules.find(rule =>
      minimatch(filename, rule.glob)
    )
    return matchedRule ? matchedRule.owners : []
  })
  const uniqueFileOwnersMap = new Map(
    fileOwners.map(owner => [owner.name, owner])
  )
  return [...uniqueFileOwnersMap.values()]
}
