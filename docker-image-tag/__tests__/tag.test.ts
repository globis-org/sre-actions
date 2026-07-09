import { context } from '@actions/github'
import { getExecOutput } from '@actions/exec'

import { suffix, generateTag } from '../src/tag'

const mockGetExecOutput = getExecOutput as jest.Mock

describe('suffix', () => {
  test('hash type returns short commit hash', () => {
    expect(suffix('hash', 'refs/heads/main', 'e78ab41287b43959657720615f80cc716f67226c')).toBe(
      'e78ab41'
    )
  })

  test('tag type returns tag value from ref', () => {
    expect(suffix('tag', 'refs/tags/v1.0.0', 'e78ab41287b43959657720615f80cc716f67226c')).toBe(
      'v1.0.0'
    )
  })

  test('auto type returns tag when ref is a tag', () => {
    expect(suffix('auto', 'refs/tags/v2.3.1', 'e78ab41287b43959657720615f80cc716f67226c')).toBe(
      'v2.3.1'
    )
  })

  test('auto type returns short hash when ref is a branch', () => {
    expect(suffix('auto', 'refs/heads/main', 'e78ab41287b43959657720615f80cc716f67226c')).toBe(
      'e78ab41'
    )
  })

  test('throws on invalid type', () => {
    expect(() => suffix('unknown', 'refs/heads/main', 'abc1234')).toThrow('invalid tag type')
  })
})

describe('generateTag', () => {
  beforeEach(() => {
    context.ref = 'refs/heads/main'
    context.sha = 'e78ab41287b43959657720615f80cc716f67226c'
    mockGetExecOutput.mockResolvedValue({ stdout: '20260709-120000\n', stderr: '', exitCode: 0 })
  })

  test('generates tag with env prefix', async () => {
    const result = await generateTag('prod', 'hash')
    expect(result).toEqual({
      imageTag: 'prod-20260709-120000-e78ab41',
      latestTag: 'prod-latest',
    })
  })

  test('generates tag without env prefix', async () => {
    const result = await generateTag('', 'hash')
    expect(result).toEqual({
      imageTag: '20260709-120000-e78ab41',
      latestTag: 'latest',
    })
  })

  test('generates tag with tag ref in auto mode', async () => {
    context.ref = 'refs/tags/v1.0.0'
    const result = await generateTag('stg', 'auto')
    expect(result).toEqual({
      imageTag: 'stg-20260709-120000-v1.0.0',
      latestTag: 'stg-latest',
    })
  })
})
