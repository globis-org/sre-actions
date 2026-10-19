import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

import {
  aggregateStatus,
  buildPlan,
  lastSections,
  MISSING_COMMENT,
  selectPlanComments,
  type StatusRecord,
} from './atlantis'
import type { Plan } from './plan'
import { TfcClient } from './tfc'
import { collectHcpPlan, workspaceStatuses } from './hcp'
import { destroyOrReplace, renderLatestPlans, renderSummary } from './summary'

type Octokit = ReturnType<typeof getOctokit>

const repo = { owner: context.repo.owner, repo: context.repo.repo }

// 実測ではコメントは status の更新より先に投稿されるが、順序は保証されないので
// project のコメントが見つからないときは 5 秒おきに 3 回まで取り直す
const COMMENT_RETRIES = 3
const COMMENT_RETRY_MS = 5000

async function collectPlan(
  octokit: Octokit,
  issueNumber: number,
  statuses: StatusRecord[],
  login: string
): Promise<{ plan: Plan; latest: string }> {
  const aggregate = aggregateStatus(statuses)
  if (aggregate.kind === 'pending') {
    core.warning('atlantis/plan is still pending. Run this action after the plan finishes.')
  }
  if (aggregate.kind !== 'settled') {
    return { plan: buildPlan(aggregate, statuses, []), latest: '' }
  }
  for (let attempt = 0; ; attempt++) {
    const all = await octokit.paginate(octokit.rest.issues.listComments, {
      ...repo,
      issue_number: issueNumber,
      since: aggregate.since,
      per_page: 100,
    })
    const comments = selectPlanComments(
      all.map(c => ({
        login: c.user?.login ?? '',
        type: c.user?.type ?? '',
        createdAt: c.created_at,
        body: c.body ?? '',
      })),
      login,
      aggregate.since
    )
    const plan = buildPlan(aggregate, statuses, comments)
    if (attempt >= COMMENT_RETRIES || !plan.projects.some(p => p.reason === MISSING_COMMENT)) {
      return { plan, latest: renderLatestPlans(lastSections(comments)) }
    }
    await new Promise(resolve => setTimeout(resolve, COMMENT_RETRY_MS))
  }
}

type Mode =
  | 'disabled'
  | { kind: 'atlantis'; login: string }
  | { kind: 'hcp'; tfc: TfcClient; organization: string }

function readInputs(): Mode {
  const atlantisLogin = core.getInput('atlantis-comment-author')
  const token = core.getInput('hcp-terraform-token')
  const organization = core.getInput('hcp-terraform-organization')
  const hostname = core.getInput('hcp-terraform-hostname') || 'app.terraform.io'
  if (atlantisLogin !== '' && organization !== '') {
    throw new Error('atlantis-comment-author and hcp-terraform-organization are mutually exclusive')
  }
  if (token !== '' && organization === '') {
    throw new Error('hcp-terraform-organization is required when hcp-terraform-token is set')
  }
  if (atlantisLogin !== '') {
    return { kind: 'atlantis', login: atlantisLogin }
  }
  if (organization !== '') {
    // fork からの PR では secrets が空になる。plan 抜きで PR 情報と diff は書き出す
    if (token === '') {
      core.warning('hcp-terraform-token is empty; HCP Terraform plans are not collected.')
      return 'disabled'
    }
    return { kind: 'hcp', tfc: new TfcClient(hostname, token), organization }
  }
  return 'disabled'
}

async function run(): Promise<void> {
  const octokit = getOctokit(core.getInput('github-token', { required: true }))
  const number = Number(core.getInput('pull-request-number', { required: true }))
  const outputDir = path.resolve(core.getInput('output-dir') || '.claude-review')
  const mode = readInputs()

  const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: number })
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    ...repo,
    pull_number: number,
    per_page: 100,
  })
  // 起動した時点の head に揃える。前段で plan を待つ間に push されると、API の PR はもう新しい
  // head を指しているが、checkout したコードと待った plan は起動時の head のもの
  const event = context.payload.pull_request
  const headSha: string = event?.number === number ? event['head'].sha : pr.head.sha
  const { data: diff } = await octokit.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${pr.base.sha}...${headSha}`,
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
    headRefOid: headSha,
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
  core.setOutput('head-sha', headSha)
  if (mode === 'disabled') {
    core.setOutput('plan-state', 'disabled')
    core.setOutput('resource-count', '0')
    core.setOutput('destroy-or-replace', 'unknown')
    return
  }

  const statuses = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
    ...repo,
    ref: headSha,
    per_page: 100,
  })
  let plan: Plan
  let details: string
  let legacyName: string
  if (mode.kind === 'atlantis') {
    ;({ plan, latest: details } = await collectPlan(octokit, number, statuses, mode.login))
    legacyName = 'atlantis-plan-latest.md'
    if (plan.state === 'pending' && plan.projects.length > 0) {
      core.warning('Some atlantis/plan project statuses are still pending.')
    }
  } else {
    const workspaces = workspaceStatuses(statuses, mode.organization)
    if (workspaces.size === 0) {
      core.warning(
        `No HCP Terraform statuses for organization "${mode.organization}" on ${headSha}.`
      )
    }
    ;({ plan, latest: details } = await collectHcpPlan(mode.tfc, workspaces, core.warning))
    legacyName = 'hcp-terraform-plan-latest.md'
    if (plan.state === 'pending') {
      core.warning(
        'Some HCP Terraform runs are still pending. Run this action after the runs finish.'
      )
    }
  }
  const summary = renderSummary(plan)
  await write('plan-summary.md', summary)
  await write('plan-details.md', details)
  // 取得元ごとの名前は互換のために残している (非推奨)。中身は plan-details.md と同じ
  await write(legacyName, details)

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
