// diff (git の unified diff) から、PR の head 側で review comment を付けられる行を取り出す。
//
// GitHub の review comment は、diff に無いファイルの行と hunk の外の行には付けられない
// (API が "could not be resolved" などで失敗する)。inline コメントを投稿する前に、行がこの一覧に
// あるかで確かめられるようにする

// git の C 形式のクォート ("b/\346\227\245.tf" など) を戻す。8 進のエスケープは UTF-8 のバイト列
function unquote(text: string): string {
  const bytes: number[] = []
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
  }
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i] ?? ''
    if (char !== '\\') {
      bytes.push(...Buffer.from(char))
      continue
    }
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1))?.[0]
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8))
      i += 3
    } else {
      const next = text[i + 1] ?? ''
      bytes.push(...Buffer.from(escapes[next] ?? next))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// "+++ b/<path>" の <path>。削除されたファイル ("+++ /dev/null") は null。
// 空白を含む名前には git が末尾にタブを付ける
export function headPath(header: string): string | null {
  const raw = header.replace(/\t$/, '')
  const path = raw.startsWith('"') ? unquote(raw) : raw
  return path === '/dev/null' ? null : path.replace(/^b\//, '')
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// head 側の行 (追加行と前後の行) を "<path>:<line>:<原文>" で返す。行番号は head のファイルの行番号
export function commentableLines(diff: string): string[] {
  const result: string[] = []
  let path: string | null = null
  // hunk の残りの行数。hunk の中の "+++ " や "--- " で始まる行をファイルの見出しと取り違えないため
  let oldLeft = 0
  let newLeft = 0
  let line = 0
  for (const raw of diff.split('\n')) {
    const text = raw.replace(/\r$/, '')
    if (oldLeft > 0 || newLeft > 0) {
      const mark = text[0] ?? ' '
      if (mark === '\\') {
        // "\ No newline at end of file"
        continue
      }
      if (mark === '-') {
        oldLeft--
        continue
      }
      if (path !== null) {
        result.push(`${path}:${line}:${text.slice(1)}`)
      }
      line++
      newLeft--
      if (mark !== '+') {
        oldLeft--
      }
      continue
    }
    if (text.startsWith('diff --git ')) {
      path = null
    } else if (text.startsWith('+++ ')) {
      path = headPath(text.slice(4))
    } else {
      const hunk = HUNK.exec(text)
      if (hunk !== null) {
        oldLeft = Number(hunk[1] ?? 1)
        line = Number(hunk[2])
        newLeft = Number(hunk[3] ?? 1)
      }
    }
  }
  return result
}
