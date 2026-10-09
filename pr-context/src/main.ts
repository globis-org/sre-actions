import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

import { parsePlanComments, selectPlanComments } from './atlantis'
import { getInputs, pullRequestNumberFromPayload, type Inputs } from './inputs'
import { disabledPlan, isDestructive, renderPlanSummary, type PlanResult } from './plan'
import { diffFromFiles, toPrInfo, type PullRequestFile } from './pull-request'
import { waitForStatus } from './wait'

type Octokit = ReturnType<typeof getOctokit>

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// head と base の sha を固定して diff を取る。PR の diff API は呼んだ時点の head を返すため、
// 取得の途中で push されると pr-info.json と食い違う
async function fetchDiff(
  octokit: Octokit,
  base: string,
  head: string,
  files: PullRequestFile[]
): Promise<{ diff: string; truncated: boolean }> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: context.repo.owner,
      repo: context.repo.repo,
      basehead: `${base}...${head}`,
      mediaType: { format: 'diff' },
    })
    return { diff: data as unknown as string, truncated: false }
  } catch (error) {
    core.warning(
      `Failed to fetch the full diff, falling back to per-file patches: ${error instanceof Error ? error.message : String(error)}`
    )
    return { diff: diffFromFiles(files), truncated: true }
  }
}

async function collectAtlantisPlan(
  octokit: Octokit,
  inputs: Inputs,
  pullRequestNumber: number,
  headSha: string
): Promise<{ plan: PlanResult; raw: string }> {
  core.info(
    `Waiting for "${inputs.atlantisStatusContext}" on ${headSha} (max ${inputs.maxWaitTime}s, start timeout ${inputs.startTimeout}s)`
  )
  const status = await waitForStatus({
    fetchStatuses: () => listStatuses(octokit, headSha),
    context: inputs.atlantisStatusContext,
    maxWaitMs: inputs.maxWaitTime * 1000,
    startTimeoutMs: inputs.startTimeout * 1000,
    pollMs: inputs.pollInterval * 1000,
    onPoll: result => core.info(`  ${inputs.atlantisStatusContext}: ${result.kind}`),
  })
  const empty = { provider: 'atlantis', projects: [], resources: [], errors: [] }
  if (status.kind === 'missing') {
    return { plan: { ...empty, state: 'none' }, raw: '' }
  }
  if (status.kind === 'pending') {
    core.warning(`Timed out waiting for "${inputs.atlantisStatusContext}"`)
    return { plan: { ...empty, state: 'pending' }, raw: '' }
  }

  // Terraform に関係しない PR では対象 project が 0 件で、plan コメントは投稿されない
  if (status.description.startsWith('0/0 ')) {
    return { plan: { ...empty, state: 'no-projects' }, raw: '' }
  }

  // 実測ではコメントが status の更新より先に投稿されるが、順序は保証されないので
  // コメントが見つからないときは少し待って取り直す
  let comments: string[] = []
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await sleep(inputs.pollInterval * 1000)
    }
    const all = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullRequestNumber,
      since: status.firstCreatedAt,
      per_page: 100,
    })
    comments = selectPlanComments(
      all.map(c => ({ author: c.user?.login ?? '', createdAt: c.created_at, body: c.body ?? '' })),
      { author: inputs.atlantisCommentAuthor, since: status.firstCreatedAt }
    )
    if (comments.length > 0) {
      break
    }
  }
  return { plan: parsePlanComments(comments), raw: comments.join('\n\n---\n\n') }
}

function listStatuses(octokit: Octokit, ref: string) {
  return octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref,
    per_page: 100,
  })
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs()
    const octokit = getOctokit(inputs.githubToken)
    const pullRequestNumber =
      inputs.pullRequestNumber ??
      pullRequestNumberFromPayload(context.payload as Record<string, unknown>)
    if (pullRequestNumber === null) {
      throw new Error(
        `Could not determine the pull request number from the "${context.eventName}" event. Specify the "pull-request-number" input.`
      )
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullRequestNumber,
    })
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullRequestNumber,
      per_page: 100,
    })
    const { diff, truncated } = await fetchDiff(octokit, pr.base.sha, pr.head.sha, files)

    const outputDir = path.resolve(inputs.outputDir)
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      path.join(outputDir, 'pr-info.json'),
      `${JSON.stringify(toPrInfo(pr, files), null, 2)}\n`
    )
    await writeFile(path.join(outputDir, 'pr-diff.patch'), diff)

    let plan = disabledPlan()
    if (inputs.atlantisCommentAuthor !== '') {
      const atlantis = await collectAtlantisPlan(octokit, inputs, pullRequestNumber, pr.head.sha)
      plan = atlantis.plan
      await writeFile(path.join(outputDir, 'atlantis-plan.md'), atlantis.raw)
    }
    const summary = renderPlanSummary(plan)
    await writeFile(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
    await writeFile(path.join(outputDir, 'plan-summary.md'), summary)

    core.setOutput('output-dir', outputDir)
    core.setOutput('head-sha', pr.head.sha)
    core.setOutput('diff-truncated', String(truncated))
    core.setOutput('plan-state', plan.state)
    core.setOutput('resource-count', String(plan.resources.length))
    core.setOutput('has-destructive-changes', String(plan.resources.some(isDestructive)))

    core.info(`Wrote PR context for #${pullRequestNumber} (${pr.head.sha}) to ${outputDir}`)
    core.info(summary)
    if (process.env['GITHUB_STEP_SUMMARY']) {
      await core.summary.addHeading(`PR context #${pullRequestNumber}`, 2).addRaw(summary).write()
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void run()
