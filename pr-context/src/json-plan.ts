// terraform show -json 相当の JSON plan (HCP Terraform の json-output-redacted) から、
// リソースごとの属性の差分を描画する。Structured Run Output の workspace でも属性の変更内容を
// plan-details.md に出すために使う。
//
// 描画は Terraform の人間向け出力の再現ではなく、変更された属性を `key: before -> after` で並べる
// だけ。入れ子の値は JSON のまま出す (reviewer は LLM なので読める)

import type { ResourceAction } from './plan'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// after_unknown / before_sensitive / after_sensitive は値と同じ形で true を置く。
// 属性単位では最上位のキーが true かどうかだけを見る
type Marks = { [key: string]: Json } | boolean | null | undefined

export type ResourceChange = {
  address: string
  previousAddress?: string
  action: ResourceAction | 'read'
  reason?: string
  importId?: string
  before: { [key: string]: Json } | null
  after: { [key: string]: Json } | null
  afterUnknown: Marks
  beforeSensitive: Marks
  afterSensitive: Marks
  // 置き換えの原因になった属性 (最上位のキー)
  replaceKeys: Set<string>
}

type RawResourceChange = {
  address: string
  previous_address?: string
  action_reason?: string | null
  change: {
    actions: string[]
    before: { [key: string]: Json } | null
    after: { [key: string]: Json } | null
    after_unknown?: Marks
    before_sensitive?: Marks
    after_sensitive?: Marks
    replace_paths?: (string | number)[][] | null
    importing?: { id?: string } | null
  }
}

function actionOf(raw: RawResourceChange): ResourceChange['action'] | null {
  const actions = raw.change.actions.join(',')
  switch (actions) {
    case 'create':
    case 'update':
    case 'delete':
    case 'read':
    case 'forget':
      return actions
    case 'delete,create':
    case 'create,delete':
      return 'replace'
    case 'no-op':
      // 純粋な import と moved だけのリソースは no-op で表現される
      if (raw.change.importing) {
        return 'import'
      }
      return raw.previous_address === undefined ? null : 'move'
    default:
      return null
  }
}

// 変更のあるリソースだけを返す (no-op は import / move を除いて落とす)
export function parseJsonPlan(raw: string): ResourceChange[] {
  const document = JSON.parse(raw) as { resource_changes?: RawResourceChange[] }
  const changes: ResourceChange[] = []
  for (const rc of document.resource_changes ?? []) {
    const action = actionOf(rc)
    if (action === null) {
      continue
    }
    const change: ResourceChange = {
      address: rc.address,
      action,
      before: rc.change.before,
      after: rc.change.after,
      afterUnknown: rc.change.after_unknown,
      beforeSensitive: rc.change.before_sensitive,
      afterSensitive: rc.change.after_sensitive,
      replaceKeys: new Set(
        (rc.change.replace_paths ?? []).map(path => String(path[0])).filter(k => k !== 'undefined')
      ),
    }
    if (rc.previous_address !== undefined) {
      change.previousAddress = rc.previous_address
    }
    if (rc.action_reason) {
      change.reason = rc.action_reason
    }
    if (rc.change.importing?.id !== undefined) {
      change.importId = rc.change.importing.id
    }
    changes.push(change)
  }
  return changes
}

const marked = (marks: Marks, key: string): boolean =>
  typeof marks === 'object' && marks !== null && marks[key] === true

const HEADER: Record<ResourceChange['action'], string> = {
  create: '+   create ',
  update: '!   update ',
  delete: '-   destroy',
  replace: '-/+ replace',
  read: '<=  read   ',
  move: '>   move   ',
  import: '+   import ',
  forget: '    forget ',
}

const format = (value: Json | undefined): string =>
  value === undefined ? 'null' : JSON.stringify(value)

export function renderResourceChange(change: ResourceChange): string {
  const suffix = [
    change.previousAddress === undefined ? '' : ` (from ${change.previousAddress})`,
    change.reason === undefined ? '' : ` (${change.reason})`,
    change.importId === undefined ? '' : ` (imported from ${JSON.stringify(change.importId)})`,
  ].join('')
  const lines = [`${HEADER[change.action]} ${change.address}${suffix}`]

  const before = change.before ?? {}
  const after = change.after ?? {}
  // apply 後に決まる属性は after に無く after_unknown にだけ出る
  const unknownKeys =
    typeof change.afterUnknown === 'object' && change.afterUnknown !== null
      ? Object.keys(change.afterUnknown).filter(k => marked(change.afterUnknown, k))
      : []
  const keys = [
    ...new Set([...Object.keys(before), ...Object.keys(after), ...unknownKeys]),
  ].toSorted()
  for (const key of keys) {
    const sensitive = marked(change.beforeSensitive, key) || marked(change.afterSensitive, key)
    const unknown = marked(change.afterUnknown, key)
    const show = (value: Json | undefined): string =>
      sensitive ? '(sensitive value)' : format(value)
    const afterText = unknown ? '(known after apply)' : show(after[key])
    const forces = change.replaceKeys.has(key) ? ' # forces replacement' : ''
    switch (change.action) {
      case 'create':
        if (unknown || (after[key] !== undefined && after[key] !== null)) {
          lines.push(`    + ${key}: ${afterText}`)
        }
        break
      case 'delete':
      case 'forget':
        if (before[key] !== undefined && before[key] !== null) {
          lines.push(`    - ${key}: ${show(before[key])}`)
        }
        break
      case 'update':
      case 'replace':
        if (unknown || JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
          lines.push(`    ~ ${key}: ${show(before[key])} -> ${afterText}${forces}`)
        }
        break
      default:
        // import / move / read は属性の差分を持たない
        break
    }
  }
  return lines.join('\n')
}
