import * as core from '@actions/core'

import { generateTag } from './tag'

async function run(): Promise<void> {
  try {
    const env = core.getInput('env')
    const suffixType = core.getInput('suffix_type')
    const { imageTag, latestTag } = await generateTag(env, suffixType)
    core.setOutput('image_tag', imageTag)
    core.setOutput('latest_tag', latestTag)
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void run()
