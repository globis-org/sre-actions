import { describe, expect, test } from 'vitest'
import { commentableLines, headPath } from '../src/diff'

describe('headPath', () => {
  test.each([
    ['b/infra/app/main.tf', 'infra/app/main.tf'],
    ['b/docs/release notes.md\t', 'docs/release notes.md'],
    ['"b/docs/\\346\\227\\245\\346\\234\\254.md"', 'docs/日本.md'],
    ['"b/docs/a\\"b.md"', 'docs/a"b.md'],
    ['/dev/null', null],
  ])('%s', (header, expected) => {
    expect(headPath(header)).toBe(expected)
  })
})

describe('commentableLines', () => {
  test('lists the added and context lines of each hunk with head line numbers', () => {
    const diff = [
      'diff --git a/infra/app/main.tf b/infra/app/main.tf',
      'index 1111111..2222222 100644',
      '--- a/infra/app/main.tf',
      '+++ b/infra/app/main.tf',
      '@@ -24,4 +24,5 @@ resource "aws_codepipeline" "app" {',
      '   stage {',
      '-    name = "Source"',
      '+    name = "Checkout"',
      '+    # comment',
      ' ',
      '   }',
      '@@ -40 +41 @@ resource "aws_s3_bucket" "logs" {',
      '-  bucket = "old"',
      '+  bucket = "new"',
      'diff --git a/README.md b/README.md',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1,2 @@',
      '+# App',
      '+text',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(commentableLines(diff)).toStrictEqual([
      'infra/app/main.tf:24:  stage {',
      'infra/app/main.tf:25:    name = "Checkout"',
      'infra/app/main.tf:26:    # comment',
      'infra/app/main.tf:27:',
      'infra/app/main.tf:28:  }',
      'infra/app/main.tf:41:  bucket = "new"',
      'README.md:1:# App',
      'README.md:2:text',
    ])
  })

  test('lines that look like file headers inside a hunk are content', () => {
    const diff = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,2 @@',
      '--- old rule',
      '+++ new rule',
      ' keep',
    ].join('\n')
    expect(commentableLines(diff)).toStrictEqual(['notes.md:1:++ new rule', 'notes.md:2:keep'])
  })

  test('skips deleted files, renames without changes and binary files', () => {
    const diff = [
      'diff --git a/old.tf b/old.tf',
      'deleted file mode 100644',
      '--- a/old.tf',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      'diff --git a/a.tf b/b.tf',
      'similarity index 100%',
      'rename from a.tf',
      'rename to b.tf',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n')
    expect(commentableLines(diff)).toStrictEqual([])
  })
})
