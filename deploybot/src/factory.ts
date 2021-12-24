import { ChatPostMessageArguments, MessageAttachment } from '@slack/web-api'
import { getOctokit, context } from '@actions/github'

import * as config from './config'
import { parse } from './parse'
import { CodeBuild, getURL } from './codebuild'

export type MessageFactoryArguments = {
  type: string
  status: string
  githubToken: string
  channel: string
  codebuild: CodeBuild
  customFields: string
  suffixOnFailure: string
}

const quote = (value: string) => '```' + value + '```'

export const messageFactory = async ({
  type: rawType,
  status,
  githubToken,
  channel,
  codebuild,
  customFields,
  suffixOnFailure,
}: MessageFactoryArguments): Promise<ChatPostMessageArguments> => {
  const octokit = getOctokit(githubToken)
  const { sha, runId, workflow } = context
  const { owner, repo } = context.repo
  const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: sha })
  const commitMessage = data.commit.message

  const githubRepo = `${owner}/${repo}`
  const githubRepoURL = `https://github.com/${owner}/${repo}`
  const githubActionsRunURL = `https://github.com/${owner}/${repo}/actions/runs/${runId}`

  const phase = config.getPhase(status)
  const type = config.getType(rawType)
  const suffix: string[] = []
  if (phase === 'failure') {
    suffix.push(
      '\u{2500}\u{2500}',
      `ログは *<${githubActionsRunURL}|こちら>*`,
      suffixOnFailure
    )
  }
  const text = [config.baseTexts[type][phase], ...suffix].join(' ')

  const fields = parse(customFields)

  const attachment: MessageAttachment = {
    color: config.colors[phase],
    fields: [
      ...fields,
      {
        title: 'Commit Message',
        value: quote(commitMessage),
        short: false,
      },
      {
        title: 'Repository',
        value: [
          `<${githubRepoURL}|${githubRepo}>`,
          `(<${githubRepoURL}/commit/${sha}|${sha.substring(0, 7)}>)`,
        ].join(' '),
        short: true,
      },
      {
        title: 'Workflow',
        value: `<${githubActionsRunURL}|${workflow}>`,
        short: true,
      },
    ],
    footer_icon: config.githubIconURL,
    footer: `<${config.actionRepoURL}|GitHub Actions - SRE>`,
    ts: `${Math.floor(Date.now() / 1000)}`,
    mrkdwn_in: ['fields', 'text'],
  }

  const url = getURL(codebuild)
  if (url.markdown) {
    attachment.fields?.push({
      title: 'CodeBuild',
      value: url.markdown,
      short: true,
    })
  }

  return {
    channel,
    text,
    attachments: [attachment],
    icon_url: config.icons[phase],
    username: config.usernames[phase],
  }
}
