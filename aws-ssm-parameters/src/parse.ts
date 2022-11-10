import { load } from 'js-yaml'
import { z } from 'zod'

const dataSchema = z.array(
  z.object({
    key: z.string().min(1),
    name: z.string().min(1),
  })
)

export type Data = z.infer<typeof dataSchema>

export type DataMap = ReadonlyMap<string, string>

export const parse = (value: string): DataMap => {
  const data = dataSchema.parse(load(value))
  return new Map(data.map(d => [d.key, d.name]))
}
