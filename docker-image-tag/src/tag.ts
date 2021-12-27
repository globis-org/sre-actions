import { context } from '@actions/github'
import { getExecOutput } from '@actions/exec'

export type Tags = {
  imageTag: string
  latestTag: string
}

export const suffix = (type: string, ref: string, sha: string): string => {
  switch (type) {
    case 'hash':
      return sha.substring(0, 7) // short commit hash
    case 'tag':
      return ref.substring(10) // tag value
    case 'auto':
      return new RegExp('^refs/tags/').test(ref)
        ? ref.substring(10)
        : sha.substring(0, 7)
    default:
      throw new Error('invalid tag type')
  }
}

export const generateTag = async (env: string, type: string): Promise<Tags> => {
  const { ref, sha } = context
  const { stdout } = await getExecOutput('date', ['+%Y%m%d-%H%M%S'])
  const timestamp = stdout.trim()
  return {
    imageTag: `${env}-${timestamp}-${suffix(type, ref, sha)}`,
    latestTag: `${env}-latest`,
  }
}
