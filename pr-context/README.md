# PR Context

Pull Request のレビューに必要なコンテキスト (PR のメタデータ、diff、Atlantis plan の結果) を集め、ファイルに書き出す GitHub Action です。

AI レビュー (claude-code-action など) の前段で実行し、レビューする側には集める作業をさせずに、書き出したファイルを読ませる使い方を想定しています。

- PR 情報と diff は同じ head commit に固定して取得する
- plan の状態と変更リソース一覧はコードで決め、LLM に列挙・判定させない

## 使用例

この action は plan の完了を待ちません。前段のジョブで [wait-for-commit-status](../wait-for-commit-status) などを使って待ちます。待機を軽い runner に置け、plan の結果でレビュー自体を skip する判断もレビューのジョブを起動する前にできるためです。

```yaml
on:
  pull_request:

jobs:
  wait-plan:
    runs-on: ubuntu-slim
    timeout-minutes: 20
    permissions:
      statuses: read
    steps:
      - uses: globis-org/sre-actions/wait-for-commit-status@v1
        with:
          check-name: atlantis/plan
        continue-on-error: true # plan が無い PR でもレビューは続ける

  review:
    needs: [wait-plan]
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
      statuses: read
    steps:
      - uses: actions/checkout@v7

      - uses: globis-org/sre-actions/pr-context@v1
        with:
          atlantis-comment-author: my-atlantis-app # Atlantis を使うリポジトリのみ

      - uses: anthropics/claude-code-action@v1
        with:
          prompt: /review-pr ${{ github.event.pull_request.number }}
          # ...
```

書き出し先 (`output-dir`、既定は `.claude-review`) はリポジトリの `.gitignore` に追加してください。

## 書き出すファイル

| ファイル           | 内容                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pr-info.json`     | PR のメタデータ。フィールド名は `gh pr view --json` に合わせる (`number`, `title`, `body`, `author`, `headRefName`, `headRefOid`, `files[].path` など) |
| `pr-diff.patch`    | base と head の SHA を固定した diff (`base...head`)                                                                                                    |
| `plan.json`        | plan の状態、project ごとの状態・status・理由・変更リソース、全体の変更リソース一覧 (Atlantis 有効時のみ)                                              |
| `plan-summary.md`  | `plan:` / `destroy / replace:` の 2 行、project の表、変更リソース一覧。レビューの prompt やサマリーにそのまま貼る用途 (Atlantis 有効時のみ)           |
| `atlantis-plan.md` | 対象にした plan コメントの原文 (Atlantis 有効時のみ)                                                                                                   |

## plan の状態 (`plan-state`)

| 値            | 意味                                                                    | `destroy-or-replace` |
| ------------- | ----------------------------------------------------------------------- | -------------------- |
| `disabled`    | `atlantis-comment-author` が空で、plan を収集していない                 | `unknown`            |
| `pending`     | plan が終わっていない                                                   | `unknown`            |
| `none`        | head commit に `atlantis/plan` の status が無い                         | `unknown`            |
| `no-projects` | 対象 project が無い (`0/0 projects planned`。Terraform に関係しない PR) | `false`              |
| `failed`      | いずれかの project の plan が失敗した                                   | `unknown`            |
| `incomplete`  | 変更リソース一覧を検証できない project がある (下記)。手動で確認する    | `unknown`            |
| `changes`     | いずれかの project に変更がある                                         | `true` / `false`     |
| `no-changes`  | 全 project が変更なし                                                   | `false`              |

`failed` / `incomplete` でも、検証できた project の destroy / replace が見つかれば `destroy-or-replace` は `true` になります。

## Atlantis の結果の組み立て方

状態は commit status から、変更リソースと失敗の理由はコメントから取ります。

1. head commit の集約 status (`atlantis/plan`) を読む。無ければ `none`、`pending` なら `pending`、description が `0/0 ` で始まれば `no-projects`
2. project ごとの status (`atlantis/plan: <dir>/<workspace>`、名前付き project は `atlantis/plan: <project>`) の最新を、その project の結果とする。description は Plan 行、`No changes.`、または失敗
3. 集約 status が head に最初に付いた時刻以降に、`atlantis-comment-author` (GitHub App) が投稿した plan コメントを集める。それより前は古い head への plan として使わない。分割された続き (`Continued plan output ...`) は前のコメントにつなぐ
4. コメントを project ごとの節に分け、project ごとに最後の節から次を取る
   - 変更リソース: `# <address> will be created` などの行 (data source の `read` は含めない)。action は `terraform plan -json` の語彙 (`create` / `update` / `delete` / `replace` / `import` / `move` / `forget`)
   - 失敗の理由: `**Plan Failed**: <理由>` の行、または `**Plan Error**` に続くエラーの最初の行
5. 変更リソースの数を status の Plan 行と突き合わせる (add = create + replace、change = update、destroy = delete + replace)。合わない、またはコメントが見つからない project は `incomplete` にする。出力の打ち切り、コメントの欠落 (折りたたみ・削除)、未知の書式で、黙って「destroy なし」と報告しないため

### 注意事項

- import と同時に update されるリソースは `update` として一覧に出る (Terraform の表示が `(imported from ...)` を併記する形のため)。import の数は突き合わせに使わない
- コメントが status より後に投稿された場合に備え、コメントが見つからない project があれば 5 秒おきに 3 回まで取り直す
- Atlantis 既定のコメントテンプレートを前提にしている。カスタマイズしている場合はリソースを抽出できず `incomplete` になる

## Inputs

| Name                      | Description                                                                                                      | Required | Default                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------- |
| `github-token`            | PR・コメント・commit status の読み取りに使う GitHub token                                                        | No       | `${{ github.token }}`                     |
| `pull-request-number`     | Pull Request 番号                                                                                                | No       | `${{ github.event.pull_request.number }}` |
| `output-dir`              | 書き出し先ディレクトリ (作業ディレクトリからの相対パス)                                                          | No       | `.claude-review`                          |
| `atlantis-comment-author` | Atlantis が plan コメントを投稿する GitHub App のログイン名 (`[bot]` の有無は問わない)。空なら plan を収集しない | No       | -                                         |

## Outputs

| Name                 | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `output-dir`         | 書き出し先ディレクトリの絶対パス                                             |
| `head-sha`           | コンテキストを取得した head commit の SHA                                    |
| `plan-state`         | plan の状態 ([plan の状態](#plan-の状態-plan-state) を参照)                  |
| `resource-count`     | 変更リソースの数 (address と action で重複を除く)                            |
| `destroy-or-replace` | destroy または replace されるリソースがあるか (`true` / `false` / `unknown`) |
