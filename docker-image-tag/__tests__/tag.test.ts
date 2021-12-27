import { suffix } from '../src/tag'

test('Generate valid suffix for docker image tag', () => {
  const tests = [
    {
      type: 'hash',
      ref: 'refs/heads/main',
      sha: 'e78ab41287b43959657720615f80cc716f67226c',
      want: 'e78ab41',
    },
    {
      type: 'auto',
      ref: 'refs/heads/main',
      sha: 'e78ab41287b43959657720615f80cc716f67226c',
      want: 'e78ab41',
    },
    {
      type: 'tag',
      ref: 'refs/tags/v1.0.0',
      sha: 'e78ab41287b43959657720615f80cc716f67226c',
      want: 'v1.0.0',
    },
    {
      type: 'auto',
      ref: 'refs/tags/v1.0.0',
      sha: 'e78ab41287b43959657720615f80cc716f67226c',
      want: 'v1.0.0',
    },
  ]

  tests.forEach(({ type, ref, sha, want }) => {
    const got = suffix(type, ref, sha)
    expect(got).toEqual(want)
  })
})
