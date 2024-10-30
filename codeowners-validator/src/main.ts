import * as core from '@actions/core'

import { validateCodeOwners } from './validate'

async function run(): Promise<void> {
  try {
    const token = core.getInput('token', { required: true })
    const codeowners = core.getInput('codeowners', { required: true })
    await validateCodeOwners({ token, codeowners })
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void run()
