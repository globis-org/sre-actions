import { describe, expect, test } from 'vitest'
import { parseJsonPlan, renderResourceChange, type ResourceChange } from '../src/json-plan'

const plan = (resourceChanges: object[]): string =>
  JSON.stringify({ format_version: '1.2', resource_changes: resourceChanges })

describe('parseJsonPlan', () => {
  test('keeps changed resources, pure imports and moves; drops other no-ops', () => {
    const changes = parseJsonPlan(
      plan([
        { address: 'a', change: { actions: ['create'], before: null, after: {} } },
        { address: 'b', change: { actions: ['delete', 'create'], before: {}, after: {} } },
        { address: 'c', change: { actions: ['create', 'delete'], before: {}, after: {} } },
        {
          address: 'd',
          change: { actions: ['no-op'], before: {}, after: {}, importing: { id: 'd-id' } },
        },
        {
          address: 'module.x.e',
          previous_address: 'e',
          change: { actions: ['no-op'], before: {}, after: {} },
        },
        { address: 'f', change: { actions: ['no-op'], before: {}, after: {} } },
        { address: 'g', change: { actions: ['forget'], before: {}, after: null } },
        { address: 'data.h', change: { actions: ['read'], before: null, after: {} } },
      ])
    )
    expect(changes.map(c => [c.address, c.action, c.importId, c.previousAddress])).toStrictEqual([
      ['a', 'create', undefined, undefined],
      ['b', 'replace', undefined, undefined],
      ['c', 'replace', undefined, undefined],
      ['d', 'import', 'd-id', undefined],
      ['module.x.e', 'move', undefined, 'e'],
      ['g', 'forget', undefined, undefined],
      ['data.h', 'read', undefined, undefined],
    ])
  })

  test('collects the top-level keys of replace_paths', () => {
    const [change] = parseJsonPlan(
      plan([
        {
          address: 'a',
          action_reason: 'replace_because_cannot_update',
          change: {
            actions: ['delete', 'create'],
            before: {},
            after: {},
            replace_paths: [['policy_arn'], ['ingress', 0, 'cidr']],
          },
        },
      ])
    )
    expect(change?.reason).toBe('replace_because_cannot_update')
    expect([...(change?.replaceKeys ?? [])]).toStrictEqual(['policy_arn', 'ingress'])
  })
})

describe('renderResourceChange', () => {
  const base = {
    afterUnknown: undefined,
    beforeSensitive: undefined,
    afterSensitive: undefined,
    replaceKeys: new Set<string>(),
  }

  test('create lists the known attributes and the ones known after apply', () => {
    const change: ResourceChange = {
      ...base,
      address: 'aws_s3_bucket.logs',
      action: 'create',
      before: null,
      after: { bucket: 'logs', tags: { env: 'prod' }, policy: null },
      afterUnknown: { id: true, arn: true, tags_all: {} },
    }
    expect(renderResourceChange(change)).toBe(
      [
        '+   create  aws_s3_bucket.logs',
        '    + arn: (known after apply)',
        '    + bucket: "logs"',
        '    + id: (known after apply)',
        '    + tags: {"env":"prod"}',
      ].join('\n')
    )
  })

  test('replace shows only the changed attributes and marks the ones forcing replacement', () => {
    const change: ResourceChange = {
      ...base,
      address: 'aws_iam_role_policy_attachment.custom[3]',
      action: 'replace',
      reason: 'replace_because_cannot_update',
      before: { id: 'attach-1', policy_arn: 'arn:aws:iam::aws:policy/Old', role: 'app' },
      after: { policy_arn: 'arn:aws:iam::aws:policy/New', role: 'app' },
      afterUnknown: { id: true },
      replaceKeys: new Set(['policy_arn']),
    }
    expect(renderResourceChange(change)).toBe(
      [
        '-/+ replace aws_iam_role_policy_attachment.custom[3] (replace_because_cannot_update)',
        '    ~ id: "attach-1" -> (known after apply)',
        '    ~ policy_arn: "arn:aws:iam::aws:policy/Old" -> "arn:aws:iam::aws:policy/New" # forces replacement',
      ].join('\n')
    )
  })

  test('sensitive attributes never show their values', () => {
    const change: ResourceChange = {
      ...base,
      address: 'aws_iam_access_key.app',
      action: 'update',
      before: { secret: 'hash-before', status: 'Active' },
      after: { secret: 'hash-after', status: 'Inactive' },
      beforeSensitive: { secret: true },
      afterSensitive: { secret: true },
    }
    expect(renderResourceChange(change)).toBe(
      [
        '!   update  aws_iam_access_key.app',
        '    ~ secret: (sensitive value) -> (sensitive value)',
        '    ~ status: "Active" -> "Inactive"',
      ].join('\n')
    )
  })

  test('delete lists the attributes being destroyed', () => {
    const change: ResourceChange = {
      ...base,
      address: 'aws_instance.web[1]',
      action: 'delete',
      reason: 'delete_because_each_key',
      before: { ami: 'ami-old', id: 'i-1', tags: null },
      after: null,
    }
    expect(renderResourceChange(change)).toBe(
      [
        '-   destroy aws_instance.web[1] (delete_because_each_key)',
        '    - ami: "ami-old"',
        '    - id: "i-1"',
      ].join('\n')
    )
  })

  test('import and move render a header only', () => {
    expect(
      renderResourceChange({
        ...base,
        address: 'aws_iam_policy.legacy',
        action: 'import',
        importId: 'arn:aws:iam::123456789012:policy/legacy',
        before: { name: 'legacy' },
        after: { name: 'legacy' },
      })
    ).toBe(
      '+   import  aws_iam_policy.legacy (imported from "arn:aws:iam::123456789012:policy/legacy")'
    )
    expect(
      renderResourceChange({
        ...base,
        address: 'module.app.aws_sqs_queue.this',
        action: 'move',
        previousAddress: 'aws_sqs_queue.app',
        before: {},
        after: {},
      })
    ).toBe('>   move    module.app.aws_sqs_queue.this (from aws_sqs_queue.app)')
  })
})
