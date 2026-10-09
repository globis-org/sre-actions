# PR Context

Pull Request のレビューに必要なコンテキスト (PR のメタデータ、diff、Terraform plan の結果) を決定的に集め、ファイルに書き出す GitHub Action です。

AI レビュー (claude-code-action など) の前段で実行し、レビューする側には「集める」作業をさせずに書き出したファイルを読ませる使い方を想定しています。

- PR 情報と diff は同じ head commit に固定して取得する (取得途中の push で食い違わない)
- plan の変更リソース一覧と状態の判定 (project ごとの最後の plan、失敗、destroy / replace の有無) をコードで行い、テストで固定する
- レビューする側の sandbox や permission の制約 (パイプ・複合コマンドの禁止、`gh api` の allow 設定など) を気にしなくてよい

## 使用例

この action は plan の完了を待ちません。plan の完了は前段のジョブで [wait-for-commit-status](../wait-for-commit-status) などを使って待ちます。待機を軽い runner の前段ジョブに置くと、レビューする側の runner をアイドルさせずに済み、plan の結果でレビュー自体を skip する判断もレビューのジョブを起動する前にできます。

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

      - name: Collect PR context
        id: context
        uses: globis-org/sre-actions/pr-context@v1
        with:
          # Atlantis を使うリポジトリのみ。省略すると plan は収集しない
          atlantis-comment-author: my-atlantis-bot

      - uses: anthropics/claude-code-action@v1
        with:
          prompt: /review-pr ${{ github.event.pull_request.number }}
          # ...
```

書き出し先 (`output-dir`、既定は `.claude-review`) はリポジトリの `.gitignore` に追加してください。

## 書き出すファイル

| ファイル           | 内容                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-info.json`     | PR のメタデータ。フィールド名は `gh pr view --json` に合わせる (`number`, `title`, `body`, `author.login`, `author.is_bot`, `headRefName`, `baseRefName`, `headRefOid`, `baseRefOid`, `files[].path` など) |
| `pr-diff.patch`    | base と head の sha を固定した unified diff (`base...head`)。diff が大きすぎて取得できない場合はファイルごとの patch から組み立てる (`diff-truncated` が `true`)                                           |
| `plan.json`        | plan の結果 (`state`, project ごとの状態と Plan 行と変更リソース、全体の変更リソース一覧)                                                                                                                  |
| `plan-summary.md`  | `plan.json` を Markdown にしたもの。`plan:` / `destroy / replace:` の 2 行、project の表、変更リソース一覧。レビューの prompt やサマリーにそのまま貼る用途                                                 |
| `atlantis-plan.md` | head commit に対する Atlantis の plan コメントの原文を時系列に結合したもの (Atlantis 有効時のみ)                                                                                                           |

### plan の状態 (`plan-state`)

| 値            | 意味                                                                                                                         | `destroy / replace:` |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `disabled`    | plan の収集が無効 (`atlantis-comment-author` が空)                                                                           | 対象外               |
| `pending`     | 実行時点で plan が終わっていない (前段で待っていない、または待機がタイムアウトした)                                          | 不明                 |
| `none`        | head commit に対する plan が無い (status が付いていない、コメントが無い)                                                     | 不明                 |
| `no-projects` | plan は実行されたが対象の project が無い (`0/0 projects planned`。Terraform に関係しない PR)                                 | なし                 |
| `unknown`     | plan のコメントはあるが形式を解釈できない、またはリソース一覧の件数が Plan 行と合わない (出力の打ち切りなど)。手動で確認する | 不明                 |
| `failed`      | いずれかの project の最後の plan が失敗、または project に紐づかない失敗 (ロックなど)                                        | 不明                 |
| `changes`     | いずれかの project に変更がある                                                                                              | 列挙 / なし          |
| `no-changes`  | 全 project が変更なし                                                                                                        | なし                 |

## Atlantis

`atlantis-comment-author` を指定すると、次の手順で plan を集めます。

1. head commit に付く `atlantis/plan` の commit status (project ごとの `atlantis/plan: <dir>/<workspace>` ではなく集約のもの) を 1 回読む。付いていなければ plan 無し (`none`)、`pending` なら `pending`、description が `0/0 ` で始まれば対象 project なし (`no-projects`) とする。コメントが見つからない場合は、投稿と status 更新の順序の揺れを考えて数秒おきに最大 3 回取り直す
2. その status が head commit に最初に付いた時刻以降に `atlantis-comment-author` が投稿した plan コメントを集める。それより前のコメントは古い head に対する plan とみなして使わない
3. 分割されたコメント (`Continued plan output from previous comment.`) は前のコメントにつなぐ
4. project (`dir` / `workspace`、名前付き project は `project` も) ごとに最後の plan の結果を採用する。前の失敗は同じ project の後の plan で上書きされ、project に紐づかない失敗は後でいずれかの project の plan が出れば解消したものとする
5. plan 出力の `# <address> will be created` などの行から変更リソースを抽出する (data source の `read` は含めない)
6. project ごとに、`Plan: N to add, M to change, K to destroy.` の件数と抽出したリソースの件数 (add = create + replace、change = update、destroy = delete + replace) を突き合わせる。合わない場合や、リソースがあるのに Plan 行が無い場合は、その project を「リソース一覧が不完全」とし、全体を `unknown` にする (取りこぼしたまま「destroy なし」と報告しないため)

変更リソースの action は `terraform plan -json` の語彙 (`create`, `update`, `delete`, `replace`, `import`, `move`, `forget`) に揃えています。

### 前提・注意事項

- Atlantis 既定のコメントテンプレートを前提にしている。テンプレートをカスタマイズしている場合や Atlantis の更新で形式が変わった場合は `unknown` になる (誤って「変更なし」にはしない)
- plan 出力が Atlantis 側で打ち切られた場合、打ち切られた部分のリソースは一覧に出ないが、手順 6 の突き合わせで `unknown` になる
- import と同時に update されるリソースは `update` として一覧に出る (Terraform の表示が `will be updated in-place` に `(imported from ...)` を併記する形のため)。import の件数は突き合わせに使わない
- Atlantis は GitHub App として動かしている前提。コメントの投稿者は login の一致に加えて `type: Bot` であることで判定する (同じ login のユーザーアカウントや、plan を引用した人のコメントを拾わないため)
- Terraform に関係しない PR でも通常は `0/0 projects planned successfully.` の status がすぐ付くので `no-projects` になる。status がまったく付かない PR は `none` になる
- Atlantis は plan を実行するたびに新しいコメントを投稿する (前のコメントは更新しない)。同じ head に対する再 plan (`atlantis plan -d <dir>` など) も手順 4 で project ごとに最後の結果が採用される
- plan の実行中に重ねて plan が起動されると `**Plan Error**` (`cannot run "plan": ... currently locked for this pull request`) が投稿されるが、実行中の plan の結果が後から来るので手順 4 により解消される

## Inputs

| Name                      | Description                                                                                                                            | Required | Default               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `github-token`            | PR・コメント・commit status の読み取りに使う GitHub token                                                                              | No       | `${{ github.token }}` |
| `pull-request-number`     | Pull Request 番号。省略時は `pull_request` 系イベント、または PR 上の `issue_comment` から取る                                         | No       | -                     |
| `output-dir`              | 書き出し先ディレクトリ (作業ディレクトリからの相対パス)                                                                                | No       | `.claude-review`      |
| `atlantis-comment-author` | Atlantis が plan コメントを投稿するアカウントのログイン名 (GitHub App の `[bot]` は付けても付けなくてもよい)。空なら plan を収集しない | No       | -                     |
| `atlantis-status-context` | Atlantis が plan に付ける commit status の context                                                                                     | No       | `atlantis/plan`       |

## Outputs

| Name                 | Description                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `output-dir`         | 書き出し先ディレクトリの絶対パス                                                                                                    |
| `head-sha`           | コンテキストを取得した head commit の SHA                                                                                           |
| `diff-truncated`     | `pr-diff.patch` をファイルごとの patch から組み立てたか                                                                             |
| `plan-state`         | plan の状態 ([plan の状態](#plan-の状態-plan-state) を参照)                                                                         |
| `resource-count`     | 変更リソースの件数 (address と action で重複を除く)                                                                                 |
| `destroy-or-replace` | destroy または replace されるリソースがあるか (`true` / `false` / `unknown`)。plan が無い・失敗・一覧を検証できないときは `unknown` |
