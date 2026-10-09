// PR のメタデータ。フィールド名は `gh pr view --json` に合わせる (既存の skill の参照を変えずに済むように)

export type PullRequestData = {
  number: number
  title: string
  body: string | null
  user: { login: string; type: string } | null
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
}

export type PullRequestFile = {
  filename: string
  status: string
  additions: number
  deletions: number
  previous_filename?: string | undefined
  patch?: string | undefined
}

export type PrInfo = {
  number: number
  title: string
  body: string
  author: { login: string; is_bot: boolean }
  headRefName: string
  baseRefName: string
  headRefOid: string
  baseRefOid: string
  files: {
    path: string
    additions: number
    deletions: number
    status: string
    previousPath?: string
  }[]
}

export function toPrInfo(pr: PullRequestData, files: PullRequestFile[]): PrInfo {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    author: { login: pr.user?.login ?? '', is_bot: pr.user?.type === 'Bot' },
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    headRefOid: pr.head.sha,
    baseRefOid: pr.base.sha,
    files: files.map(file => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
    })),
  }
}

// diff API が大きすぎて失敗したときの代替。ファイルごとの patch (GitHub 側で打ち切られうる) をつなぐ
export function diffFromFiles(files: PullRequestFile[]): string {
  return files
    .map(file => {
      const from = file.previous_filename ?? file.filename
      const header = `diff --git a/${from} b/${file.filename}`
      if (file.patch === undefined) {
        return `${header}\n# patch unavailable (binary or too large)\n`
      }
      const oldPath = file.status === 'added' ? '/dev/null' : `a/${from}`
      const newPath = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`
      return `${header}\n--- ${oldPath}\n+++ ${newPath}\n${file.patch}\n`
    })
    .join('')
}
