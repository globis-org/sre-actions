import { parse, Fields } from '../src/parse'

test('Parse valid yaml string to Fields', () => {
  const raw = `
    - title: foo
      value: bar
  `
  const want: Fields = [{ title: 'foo', value: 'bar' }]
  const got = parse(raw)

  expect(got).toStrictEqual(want)
})

test('Parse invalid yaml string to Fields', () => {
  const raw = `
    title: foo
    value: bar
  `
  const want: Fields = []
  const got = parse(raw)

  expect(got).toStrictEqual(want)
})
