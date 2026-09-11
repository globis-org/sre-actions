import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

import { evaluateApprovals, listApprovers, resolveRequiredUsers } from './approval'
import { parseCodeOwners, getFileOwners, listUniqueOwners } from './parse'

type Inputs = {
  token: string
  codeowners: string
}

const CommitContext = 'CODEOWNERS Validator'

// commit status の description は 140 文字制限
const DescriptionMaxLength = 140
const truncateDescription = (description: string): string =>
  description.length > DescriptionMaxLength
    ? `${description.slice(0, DescriptionMaxLength - 1)}…`
    : description

type MergeGroupPayload = {
  head_sha: string
}
type PullRequestPayload = {
  number: number
  head: {
    sha: string
  }
}

const targetEvents = ['pull_request', 'pull_request_review', 'merge_group']

export const validateCodeOwners = async (inputs: Inputs) => {
  const octokit = getOctokit(inputs.token)

  if (!targetEvents.includes(context.eventName)) {
    core.info(`Skipped for ${context.eventName} event.`)
    return
  }

  if (context.eventName === 'merge_group') {
    // library has no type for merge_group event
    const { head_sha: sha } = context.payload['merge_group'] as MergeGroupPayload
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state: 'success',
      context: CommitContext,
      description: 'Always passed for merge_group event.',
    })
    return
  }

  core.debug(`Context:\n${JSON.stringify(context, null, 2)}`)

  if (!context.payload.pull_request) {
    throw new Error('This event does not contain a pull request payload.')
  }

  // GitHub REST API は per_page のデフォルトが 30 件なので、paginate で全件取得する。
  // ファイル単位で判定するため、取りこぼすとそのファイルのオーナー承認を要求できず fail-open になる。
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    per_page: 100,
  })
  const filenames = files.map(file => file.filename)
  core.info(`Files in this PR:\n${filenames.join('\n')}`)

  const codeOwnersRule = parseCodeOwners(inputs.codeowners)
  core.debug(`Parsed codeowners:\n${JSON.stringify(codeOwnersRule, null, 2)}`)

  const matchedOwnersByFile = getFileOwners(filenames, codeOwnersRule)
  core.debug(`Matched owners by file:\n${JSON.stringify(matchedOwnersByFile, null, 2)}`)

  // Extract members from teams (同じオーナーを複数ファイルで参照するため 1 回だけ解決する)
  const uniqueOwners = listUniqueOwners(matchedOwnersByFile)
  const usersByOwnerPromise = uniqueOwners.map(async (owner): Promise<[string, string[]]> => {
    if (owner.kind === 'user') {
      return [owner.name, [owner.name]]
    } else {
      // 30 件を超えるチームでもメンバーを取りこぼさないよう paginate で全件取得する
      const members = await octokit.paginate(octokit.rest.teams.listMembersInOrg, {
        org: owner.org,
        team_slug: owner.team,
        per_page: 100,
      })
      return [owner.name, members.map(member => member.login)]
    }
  })
  const usersByOwner = new Map(await Promise.all(usersByOwnerPromise))

  const requiredUsersByFile = resolveRequiredUsers(matchedOwnersByFile, usersByOwner)
  core.info(
    `Required codeowners user by file:\n${requiredUsersByFile
      .map(file => `${file.filename}: ${file.requiredUsers.join(', ')}`)
      .join('\n')}`
  )

  // GitHub REST API は per_page のデフォルトが 30 件なので、paginate で全件取得する。
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    per_page: 100,
  })
  const approvers = listApprovers(reviews)
  core.info(`Approvers: ${approvers.join(', ')}`)

  const result = evaluateApprovals(requiredUsersByFile, approvers)
  const sha = (context.payload.pull_request as PullRequestPayload).head.sha

  if (result.approved) {
    core.info('Approved by CODEOWNERS.')
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state: 'success',
      context: CommitContext,
      description: truncateDescription(
        result.approvedBy.length > 0
          ? `Approved by ${result.approvedBy.join(', ')}.`
          : 'No CODEOWNERS required.'
      ),
    })
  } else {
    core.warning(`Require review by CODEOWNERS for:\n${result.unapprovedFiles.join('\n')}`)
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state: 'pending',
      context: CommitContext,
      description: truncateDescription(
        `Require review by CODEOWNERS for: ${result.unapprovedFiles.join(', ')}`
      ),
    })
  }
}
