import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { WebhookPayload } from '@actions/github/lib/interfaces'

import { parseCodeOwners, getFileOwners, listUniqueOwners } from './parse'

type Inputs = {
  token: string
  codeowners: string
}

const CommitContext = 'CODEOWNERS Validator'

type MergeGroupPayload = {
  head_sha: string
}
type PullRequestPayload = WebhookPayload['pull_request'] & {
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
    const { head_sha: sha } = context.payload.merge_group as MergeGroupPayload
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

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  })
  const filenames = files.map(file => file.filename)
  core.info(`Files in this PR:\n${filenames.join('\n')}`)

  const codeOwnersRule = parseCodeOwners(inputs.codeowners)
  core.debug(`Parsed codeowners:\n${JSON.stringify(codeOwnersRule, null, 2)}`)

  const matchedOwnersByFile = getFileOwners(filenames, codeOwnersRule)
  core.debug(
    `Matched owners by file:\n${JSON.stringify(matchedOwnersByFile, null, 2)}`
  )

  const requiredOwners = listUniqueOwners(matchedOwnersByFile)
  core.debug(`Required owners:\n${JSON.stringify(requiredOwners, null, 2)}`)

  // Extract members from teams
  const requiredUsersPromise = requiredOwners.map(async owner => {
    if (owner.kind === 'user') {
      return owner.name
    } else {
      const { data: members } = await octokit.rest.teams.listMembersInOrg({
        org: owner.org,
        team_slug: owner.team,
      })
      return members.map(member => member.login)
    }
  })
  const requiredUsers = await Promise.all(requiredUsersPromise).then(members =>
    members.flat()
  )
  core.info(`Required codeowners user: ${requiredUsers.join(', ')}`)

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  })
  const approvers = reviews
    .filter(review => review.state === 'APPROVED')
    .flatMap(review => review.user?.login ?? [])
  core.info(`Approvers: ${approvers.join(', ')}`)

  const approvedOwners = approvers.filter(approver =>
    requiredUsers.includes(approver)
  )

  const sha = (context.payload.pull_request as PullRequestPayload).head.sha
  const noOwnerRequiredButApproved =
    requiredUsers.length === 0 && approvers.length > 0
  const someOwnerApproved = approvedOwners.length > 0

  if (noOwnerRequiredButApproved || someOwnerApproved) {
    core.info('Approved by CODEOWNERS.')
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state: 'success',
      context: CommitContext,
      description: `Approved by ${approvedOwners.join(', ')}.`,
    })
  } else {
    core.warning('Require review by CODEOWNERS.')
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state: 'pending',
      context: CommitContext,
      description: 'Require review by CODEOWNERS.',
    })
  }
}
