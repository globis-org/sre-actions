// action.yaml の github-script から require して run を呼ぶ。
// YAML に埋め込むと lint / format / テストが効かないので、スクリプトはすべてここに置く

// カンマ区切りまたは改行区切りの文字列を配列にする
function parseContextNames(input) {
  return input
    .split(/\r?\n/)
    .flatMap(line => line.split(','))
    .map(name => name.trim())
    .filter(name => name.length > 0)
}

// 末尾が "*" なら前方一致、それ以外は完全一致
function matches(pattern, context) {
  return pattern.endsWith('*') ? context.startsWith(pattern.slice(0, -1)) : context === pattern
}

// combined status の API (context ごとに最新の 1 件) をページングしてすべて取る。
// 全体の state は failure を pending より優先するため使わず、statuses だけを返す
async function fetchStatuses(github, { owner, repo, ref }) {
  const statuses = []
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    })
    statuses.push(...data.statuses)
    if (data.statuses.length === 0 || statuses.length >= data.total_count) {
      return statuses
    }
  }
}

// 完了と結果を分けて判定する
// - 完了: 完全一致の名前がすべて存在し、前方一致は 1 件以上一致し、対象に pending が無い
// - 結果: 完了の時点で failure / error があれば failure、すべて success なら success
// failure があっても pending が残っていれば未完了 (同じ commit で実行が重なった場合に途中で終えないため)
function evaluate(patterns, statuses) {
  const latest = new Map()
  for (const status of statuses) {
    if (!latest.has(status.context) && patterns.some(p => matches(p, status.context))) {
      latest.set(status.context, status)
    }
  }
  const targets = [...latest.values()]
  const missing = patterns.filter(p => !targets.some(s => matches(p, s.context)))
  const pending = targets.filter(s => s.state === 'pending')
  const failed = targets.filter(s => s.state === 'failure' || s.state === 'error')
  const succeeded = targets.filter(s => s.state === 'success')
  const complete = missing.length === 0 && pending.length === 0
  return {
    complete,
    status: !complete ? 'pending' : failed.length > 0 ? 'failure' : 'success',
    missing,
    pending,
    failed,
    succeeded,
  }
}

function seconds(env, name) {
  const value = Number(env[name])
  if (env[name] === undefined || env[name].trim() === '' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number: ${env[name]}`)
  }
  return value * 1000
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// inputs は action.yaml の env で受け取る。sleep と now はテストで差し替える
async function run({
  github,
  context,
  core,
  env = process.env,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const maxWaitTime = seconds(env, 'MAX_WAIT_TIME')
  const pollInterval = seconds(env, 'POLL_INTERVAL')
  const failOnTimeout = env.FAIL_ON_TIMEOUT === 'true'
  const contextNames = parseContextNames(env.CONTEXT_NAMES ?? '')
  if (contextNames.length === 0) {
    throw new Error('context-names is empty')
  }
  if (!context.payload.pull_request) {
    throw new Error('This action can only be used in pull_request events')
  }
  const startTime = now()

  core.info(`Waiting for commit statuses: ${contextNames.join(', ')}`)
  core.info(`Max wait time: ${maxWaitTime / 1000}s, Poll interval: ${pollInterval / 1000}s`)

  core.setOutput('status', 'pending')
  core.setOutput('timed-out', 'false')
  core.setOutput('pending-count', '0')
  core.setOutput('failed-count', '0')
  core.setOutput('succeeded-count', '0')

  while (true) {
    if (now() - startTime >= maxWaitTime) {
      core.info('Timeout waiting for commit statuses')
      core.setOutput('status', 'pending')
      core.setOutput('timed-out', 'true')
      if (failOnTimeout) {
        throw new Error('Timeout waiting for commit statuses')
      }
      return
    }

    const statuses = await fetchStatuses(github, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.payload.pull_request.head.sha,
    })
    core.info(`Found ${statuses.length} commit statuses`)

    const result = evaluate(contextNames, statuses)
    for (const s of [...result.pending, ...result.failed, ...result.succeeded]) {
      core.info(`  - ${s.context}: ${s.state} - ${s.description}`)
    }
    core.setOutput('pending-count', String(result.pending.length))
    core.setOutput('failed-count', String(result.failed.length))
    core.setOutput('succeeded-count', String(result.succeeded.length))

    if (result.complete) {
      core.setOutput('status', result.status)
      core.info(
        result.status === 'failure'
          ? `✗ Status: failure (${result.failed.map(s => s.context).join(', ')})`
          : '✓ Status: success'
      )
      return
    }

    if (result.missing.length > 0) {
      core.info(`Not all statuses found yet. Missing: ${result.missing.join(', ')}`)
    }
    if (result.pending.length > 0) {
      core.info(`⏳ Pending: ${result.pending.map(s => s.context).join(', ')}`)
    }
    await sleep(pollInterval)
  }
}

module.exports = { evaluate, fetchStatuses, matches, parseContextNames, run }
