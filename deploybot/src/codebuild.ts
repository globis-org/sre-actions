export type CodeBuild = {
  id: string
  region: string
}

export type CodeBuildOutput = { raw?: string; markdown?: string }

export const getURL = ({ id, region }: CodeBuild): CodeBuildOutput => {
  const split = id.split(':')
  const [project, uuid] = split

  if (!project || !uuid) {
    return {}
  }

  const url = `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${project}/build/${project}%3A${uuid}/log?region=${region}`
  return {
    raw: url,
    markdown: `<${url}|${project}>`,
  }
}
