import type { getOctokit } from '@actions/github'

type Octokit = ReturnType<typeof getOctokit>

// marker を含む既存コメントがあれば更新し、なければ作成する
export async function upsertComment(
  octokit: Octokit,
  params: { owner: string; repo: string; issueNumber: number; marker: string; body: string }
): Promise<{ id: number; htmlUrl: string }> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    per_page: 100,
  })
  const existing = comments.find(comment => comment.body?.includes(params.marker) === true)
  if (existing !== undefined) {
    const { data } = await octokit.rest.issues.updateComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: existing.id,
      body: params.body,
    })
    return { id: data.id, htmlUrl: data.html_url }
  }
  const { data } = await octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: params.body,
  })
  return { id: data.id, htmlUrl: data.html_url }
}
