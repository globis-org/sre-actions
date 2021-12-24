import * as core from '@actions/core'
import { WebClient } from '@slack/web-api'

import { messageFactory } from './factory'

async function run(): Promise<void> {
  try {
    const token = core.getInput('token')
    const web = new WebClient(token)
    core.info('[Info] Slack client has been initialized.')

    const channel = core.getInput('channel')
    const githubToken = core.getInput('github_token')
    const status = core.getInput('status')
    const type = core.getInput('type')
    const codebuildID = core.getInput('codebuild_id')
    const codebuildRegion = core.getInput('codebuild_region')
    const customFields = core.getInput('custom_fields')
    const suffixOnFailure = core.getInput('suffix_on_failure')

    const message = await messageFactory({
      type,
      status,
      githubToken,
      channel,
      customFields,
      codebuild: { id: codebuildID, region: codebuildRegion },
      suffixOnFailure,
    })
    core.debug(`[Info] Request body \n${JSON.stringify(message, undefined, 4)}`)
    const { ok, error } = await web.chat.postMessage(message)
    core.info(`[Info] Request result is ${ok.toString()}`)
    if (error) {
      throw new Error(error)
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void run()
