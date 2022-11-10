import { parse, DataMap } from '../src/parse'

test('Parse valid yaml string to DataMap', () => {
  const raw = `
    - key: /dev/parameter-a
      name: PARAMETER_A
    - key: /dev/parameter-b
      name: PARAMETER_B
  `
  const want: DataMap = new Map([
    ['/dev/parameter-a', 'PARAMETER_A'],
    ['/dev/parameter-b', 'PARAMETER_B'],
  ])
  const got = parse(raw)

  expect(got).toStrictEqual(want)
})
