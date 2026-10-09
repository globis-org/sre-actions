import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

import { aggregateStatus, buildPlan, selectPlanComments, type Plan } from './atlantis'
import { destroyOrReplace, renderSummary } from './summary'

type Octokit = ReturnType<typeof getOctokit>

const repo = { owner: context.repo.owner, repo: context.repo.repo }

// 実測ではコメントは status の更新より先に投稿されるが、順序は保証されないので
// project のコメントが見つからないときは 5 秒おきに 3 回まで取り直す
const COMMENT_RETRIES = 3
const COMMENT_RETRY_MS = 5000

async function collectPlan(
  octokit: Octokit,
  issueNumber: number,
  headSha: string,
  login: string
): Promise<{ plan: Plan; raw: string }> {
  const statuses = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
    ...repo,
    ref: headSha,
    per_page: 100,
  })
  const aggregate = aggregateStatus(statuses)
  if (aggregate.kind === 'pending') {
    core.warning('atlantis/plan is still pending. Run this action after the plan finishes.')
  }
  for (let attempt = 0; ; attempt++) {
    const comments =
      aggregate.kind === 'settled'
        ? selectPlanComments(
            (
              await octokit.paginate(octokit.rest.issues.listComments, {
                ...repo,
                issue_number: issueNumber,
                since: aggregate.since,
                per_page: 100,
              })
            ).map(c => ({
              login: c.user?.login ?? '',
              type: c.user?.type ?? '',
              createdAt: c.created_at,
              body: c.body ?? '',
            })),
            login,
            aggregate.since
          )
        : []
    const plan = buildPlan(aggregate, statuses, comments)
    const missing = plan.projects.some(p => p.reason === 'plan コメントが見つからない')
    if (!missing || attempt >= COMMENT_RETRIES) {
      return { plan, raw: comments.join('\n\n---\n\n') }
    }
    await new Promise(resolve => setTimeout(resolve, COMMENT_RETRY_MS))
  }
}

async function run(): Promise<void> {
  const octokit = getOctokit(core.getInput('github-token', { required: true }))
  const number = Number(core.getInput('pull-request-number', { required: true }))
  const outputDir = path.resolve(core.getInput('output-dir') || '.claude-review')
  const atlantisLogin = core.getInput('atlantis-comment-author')

  const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: number })
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    ...repo,
    pull_number: number,
    per_page: 100,
  })
  // PR の diff API は呼んだ時点の head を返すので、sha を固定して pr-info.json と揃える
  const { data: diff } = await octokit.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${pr.base.sha}...${pr.head.sha}`,
    mediaType: { format: 'diff' },
  })

  await mkdir(outputDir, { recursive: true })
  const write = (name: string, content: string): Promise<void> =>
    writeFile(path.join(outputDir, name), content)
  // フィールド名は gh pr view --json に合わせる
  const prInfo = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    author: { login: pr.user.login, is_bot: pr.user.type === 'Bot' },
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    headRefOid: pr.head.sha,
    baseRefOid: pr.base.sha,
    files: files.map(f => ({
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    })),
  }
  await write('pr-info.json', `${JSON.stringify(prInfo, null, 2)}\n`)
  await write('pr-diff.patch', diff as unknown as string)

  core.setOutput('output-dir', outputDir)
  core.setOutput('head-sha', pr.head.sha)
  if (atlantisLogin === '') {
    core.setOutput('plan-state', 'disabled')
    return
  }

  const { plan, raw } = await collectPlan(octokit, number, pr.head.sha, atlantisLogin)
  const summary = renderSummary(plan)
  await write('plan.json', `${JSON.stringify(plan, null, 2)}\n`)
  await write('plan-summary.md', summary)
  await write('atlantis-plan.md', raw)

  core.setOutput('plan-state', plan.state)
  core.setOutput('resource-count', String(plan.resources.length))
  core.setOutput('destroy-or-replace', destroyOrReplace(plan))
  core.info(summary)
  if (process.env['GITHUB_STEP_SUMMARY']) {
    await core.summary.addRaw(summary).write()
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
