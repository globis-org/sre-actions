import * as core from '@actions/core'

import { run } from './checker'

async function main(): Promise<void> {
  try {
    const path = core.getInput('path') || '.'
    const config = core.getInput('config') || '.skill-policy.yaml'
    const strict = core.getInput('strict') === 'true'

    const result = run({ path, config, format: 'github', strict })

    if (result.output) {
      core.info(result.output)
    }

    if (result.hasErrors) {
      core.setFailed('Skill frontmatter lint failed')
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void main()
