import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

import { upsertComment } from './comment'
import { evaluateGate, filterApproversWithWriteAccess, listHumanApprovers } from './gate'
import { getInputs } from './inputs'
import { parsePlanLog } from './log'
import { COMMENT_MARKER, renderComment, type WorkspaceResult } from './render'
import { contextName, waitForStatuses, type WorkspaceStatus } from './statuses'
import { TfcApiError, TfcClient } from './tfc'

async function collectResult(
  tfc: TfcClient,
  workspace: string,
  status: WorkspaceStatus
): Promise<WorkspaceResult> {
  const result: WorkspaceResult = {
    workspace,
    kind: status.kind,
    runId: 'runId' in status ? status.runId : null,
    runUrl: 'runUrl' in status ? status.runUrl : null,
    description: 'description' in status ? status.description : '',
    plan: null,
    log: null,
  }
  if ((status.kind !== 'finished' && status.kind !== 'errored') || result.runId === null) {
    return result
  }
  try {
    result.plan = await tfc.getPlanForRun(result.runId)
    if (result.plan?.logReadUrl) {
      result.log = parsePlanLog(await tfc.fetchLog(result.plan.logReadUrl))
    }
  } catch (error) {
    // 認証・権限エラーは全 workspace で同じ結果になるので、黙って続けずに失敗させる
    if (error instanceof TfcApiError && (error.status === 401 || error.status === 403)) {
      throw error
    }
    // それ以外は plan の取得に失敗してもコメント自体は出す (リンクは残る)
    core.warning(
      `Failed to fetch plan for ${workspace} (${result.runId}): ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return result
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs()
    const pullRequest = context.payload.pull_request
    if (pullRequest === undefined) {
      throw new Error('This action can only be used in pull_request events')
    }
    const sha = String(pullRequest['head']?.sha ?? '')
    const octokit = getOctokit(inputs.githubToken)
    const tfc = new TfcClient(inputs.hostname, inputs.token)

    const repository = `${context.repo.owner}/${context.repo.repo}`
    const baseRef = String(pullRequest['base']?.ref ?? '')
    let workspaces = inputs.workspaces
    // speculative plan が無効で status が付かない workspace。gate 有効時は fail-closed で failure にする
    let unobservable: string[] = []
    if (workspaces.length === 0) {
      const discovered = await tfc.listWorkspacesForRepo(inputs.organization, repository)
      // PR の base と別のブランチを追跡している workspace はこの PR に status を付けないので対象外
      const relevant = discovered.filter(ws => ws.branch === '' || ws.branch === baseRef)
      workspaces = relevant.filter(ws => ws.speculativeEnabled).map(ws => ws.name)
      unobservable = relevant.filter(ws => !ws.speculativeEnabled).map(ws => ws.name)
      if (workspaces.length === 0 && unobservable.length === 0) {
        throw new Error(
          `No workspaces connected to ${repository} were found in organization "${inputs.organization}". Specify the "workspaces" input.`
        )
      }
      core.info(`Discovered ${workspaces.length} workspace(s): ${workspaces.join(', ')}`)
      if (unobservable.length > 0) {
        core.warning(
          `Speculative plans are disabled for ${unobservable.join(', ')}; their changes cannot be checked on pull requests`
        )
      }
    }
    const contexts = new Map(
      workspaces.map(workspace => [
        contextName(inputs.organization, workspace, inputs.hcpStatusPrefix),
        workspace,
      ])
    )

    core.info(
      `Waiting for HCP Terraform runs on ${sha} (max ${inputs.maxWaitTime}s, every ${inputs.pollInterval}s)`
    )
    const { statuses, timedOut, observedContexts } = await waitForStatuses({
      fetchStatuses: () =>
        octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
          owner: context.repo.owner,
          repo: context.repo.repo,
          ref: sha,
          per_page: 100,
        }),
      expectedContexts: [...contexts.keys()],
      maxWaitMs: inputs.maxWaitTime * 1000,
      pollMs: inputs.pollInterval * 1000,
      onPoll: current => {
        const settled = [...current.values()].filter(
          s => s.kind !== 'pending' && s.kind !== 'missing'
        ).length
        core.info(`  ${settled}/${current.size} workspace(s) settled`)
      },
    })
    if (timedOut) {
      core.warning('Timed out waiting for HCP Terraform runs')
    }
    // 期待セットに無い HCP Terraform の status は、token から見えない project の workspace や
    // workspaces の指定漏れを意味する。gate 有効時は fail-closed で failure にする
    const organizationPrefix = `${inputs.hcpStatusPrefix}${inputs.organization}/`
    const unexpected = observedContexts
      .filter(ctx => ctx.startsWith(organizationPrefix) && !contexts.has(ctx))
      .map(ctx => ctx.slice(organizationPrefix.length))
    if (unexpected.length > 0) {
      core.warning(
        `HCP Terraform statuses found for workspaces outside the checked set: ${unexpected.join(', ')}`
      )
    }

    const results: WorkspaceResult[] = []
    for (const [contextKey, workspace] of contexts) {
      const status = statuses.get(contextKey) ?? { kind: 'missing' }
      results.push(await collectResult(tfc, workspace, status))
    }

    const errored = results.filter(result => result.kind === 'errored')
    const unsettled = results.filter(
      result => result.kind === 'pending' || result.kind === 'missing'
    )
    const combined = errored.length > 0 ? 'failure' : unsettled.length > 0 ? 'pending' : 'success'
    const hasChanges = results.some(result => result.plan?.hasChanges === true)

    core.setOutput('status', combined)
    core.setOutput('has-changes', String(hasChanges))
    core.setOutput(
      'results',
      JSON.stringify(
        results.map(result => ({
          workspace: result.workspace,
          status: result.kind,
          runId: result.runId,
          runUrl: result.runUrl,
          hasChanges: result.plan?.hasChanges ?? false,
          add: result.plan?.additions ?? 0,
          change: result.plan?.changes ?? 0,
          destroy: result.plan?.destructions ?? 0,
          import: result.plan?.imports ?? 0,
        }))
      )
    )

    let commentId = ''
    let commentUrl: string | null = null
    if (inputs.comment) {
      const body = renderComment(results, { sha, showUntriggered: inputs.showUntriggered })
      const comment = await upsertComment(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        issueNumber: inputs.pullRequestNumber,
        marker: COMMENT_MARKER,
        body,
      })
      commentId = String(comment.id)
      commentUrl = comment.htmlUrl
      core.info(`Posted comment ${commentUrl}`)
    }
    core.setOutput('comment-id', commentId)

    let gateState = ''
    if (inputs.statusContext !== '') {
      // bot の approve だけで diff を通さないための gate。CODEOWNERS の判定は codeowners-validator に任せる
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: inputs.pullRequestNumber,
        per_page: 100,
      })
      const humanApprovers = await filterApproversWithWriteAccess(
        listHumanApprovers(
          reviews.map(review => ({
            state: review.state,
            user:
              review.user === null ? null : { login: review.user.login, type: review.user.type },
          }))
        ),
        async username => {
          const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: context.repo.owner,
            repo: context.repo.repo,
            username,
          })
          return data.permission
        }
      )
      const gate = evaluateGate(results, {
        timedOut,
        humanApprovers,
        unexpectedWorkspaces: unexpected,
        unobservableWorkspaces: unobservable,
      })
      await octokit.rest.repos.createCommitStatus({
        owner: context.repo.owner,
        repo: context.repo.repo,
        sha,
        state: gate.state,
        context: inputs.statusContext,
        description: gate.description,
        target_url:
          commentUrl ??
          `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
      })
      gateState = gate.state
      core.info(`Commit status "${inputs.statusContext}": ${gate.state} - ${gate.description}`)
    }
    core.setOutput('gate-state', gateState)

    for (const result of results) {
      core.info(
        `${result.workspace}: ${result.kind}${result.runUrl === null ? '' : ` ${result.runUrl}`}`
      )
    }
    if (inputs.failOnError && errored.length > 0) {
      core.setFailed(
        `${errored.length} HCP Terraform run(s) errored: ${errored.map(r => r.workspace).join(', ')}`
      )
      return
    }
    if (inputs.failOnTimeout && timedOut) {
      core.setFailed(`Timed out waiting for: ${unsettled.map(r => r.workspace).join(', ')}`)
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void run()
