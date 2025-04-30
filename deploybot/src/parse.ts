import { MessageAttachment } from '@slack/web-api'
import { load } from 'js-yaml'

// type Fields = {
//   title: string;
//   value: string;
//   short?: boolean | undefined;
// }[]
export type Fields = NonNullable<MessageAttachment['fields']>

// https://blog.uhy.ooo/entry/2021-04-09/typescript-is-any-as/
const isNotNullish = (obj: unknown): obj is Record<string, unknown> =>
  obj != null

const isField = (obj: unknown): obj is Fields[number] =>
  isNotNullish(obj) &&
  typeof obj['title'] === 'string' &&
  typeof obj['value'] === 'string' &&
  (typeof obj['short'] === 'boolean' || typeof obj['short'] === 'undefined')

const isFields = (obj: unknown): obj is Fields =>
  Array.isArray(obj) && obj.every(isField)

export const parse = (value: string): Fields => {
  const fields = load(value)
  return isFields(fields) ? fields : []
}
