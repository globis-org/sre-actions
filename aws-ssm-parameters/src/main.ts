import * as core from '@actions/core'
import { SSMClient, GetParametersCommand, Parameter } from '@aws-sdk/client-ssm'

import { parse } from './parse'

const BATCH_SIZE = 10

async function run(): Promise<void> {
  try {
    const dataMap = parse(core.getInput('data'))
    const keys = [...dataMap.keys()]
    const client = new SSMClient({})

    const allParameters: Parameter[] = []
    const allInvalidParameters: string[] = []

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE)
      const { Parameters, InvalidParameters } = await client.send(
        new GetParametersCommand({
          Names: batch,
          WithDecryption: true,
        })
      )
      if (Parameters) {
        allParameters.push(...Parameters)
      }
      if (InvalidParameters) {
        allInvalidParameters.push(...InvalidParameters)
      }
    }

    if (
      allInvalidParameters.length > 0 ||
      allParameters.length !== keys.length
    ) {
      throw new Error(
        `Some parameters are invalid: ${allInvalidParameters.toString()}`
      )
    }

    allParameters.forEach(({ Name: key, Value: value }) => {
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
