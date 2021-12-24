export type CodeBuild = {
  id: string
  region: string
}

export type CodeBuildOutput = { raw?: string; markdown?: string }

export const getURL = ({ id, region }: CodeBuild): CodeBuildOutput => {
  const split = id.split(':')
  if (split.length !== 2) {
    return {}
  }
  const project = split[0]
  const uuid = split[1]
  const url = `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${project}/build/${project}%3A${uuid}/log?region=${region}`
  return {
    raw: url,
    markdown: `<${url}|${project}>`,
  }
}
