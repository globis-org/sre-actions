import * as core from '@actions/core'
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm'

import { parse } from './parse'

async function run(): Promise<void> {
  try {
    const dataMap = parse(core.getInput('data'))
    const keys = [...dataMap.keys()]
    const client = new SSMClient({})
    const { Parameters, InvalidParameters } = await client.send(
      new GetParametersCommand({
        Names: keys,
        WithDecryption: true,
      })
    )
    if (!Parameters || !InvalidParameters) {
      throw Error('Parameters or InvalidParameters is undefined')
    }
    if (InvalidParameters.length > 0 || Parameters.length !== keys.length) {
      throw new Error(
        `Some parameters are invalid: ${InvalidParameters.toString()}`
      )
    }

    Parameters.forEach(({ Name: key, Value: value }) => {
      if (!key || !value) {
        throw Error('Parameter name or value is empty.')
      }
      const envVar = dataMap.get(key)?.toUpperCase() as string // Always exists

      core.setSecret(value)
      core.exportVariable(envVar, value)
      core.info(`Set ${envVar} as an environment variable.`)
    })
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

void run()
