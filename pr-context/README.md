# PR Context

Pull Request のレビューに必要なコンテキスト (PR のメタデータ、diff、Terraform plan の結果) を決定的に集め、ファイルに書き出す GitHub Action です。

AI レビュー (claude-code-action など) の前段で実行し、レビューする側には「集める」作業をさせずに書き出したファイルを読ませる使い方を想定しています。

- PR 情報と diff は同じ head commit に固定して取得する (取得途中の push で食い違わない)
- plan の変更リソース一覧と状態の判定 (project ごとの最後の plan、失敗、destroy / replace の有無) をコードで行い、テストで固定する
- レビューする側の sandbox や permission の制約 (パイプ・複合コマンドの禁止、`gh api` の allow 設定など) を気にしなくてよい

## 使用例

```yaml
on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 20 # plan の待機 (max-wait-time) を含めて見積もる
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

| 値            | 意味                                                                                         | `destroy / replace:` |
| ------------- | -------------------------------------------------------------------------------------------- | -------------------- |
| `disabled`    | plan の収集が無効 (`atlantis-comment-author` が空)                                           | 対象外               |
| `pending`     | `max-wait-time` 内に plan が終わらなかった                                                   | 不明                 |
| `none`        | head commit に対する plan が無い (`start-timeout` 内に status が付かない、コメントが無い)    | 不明                 |
| `no-projects` | plan は実行されたが対象の project が無い (`0/0 projects planned`。Terraform に関係しない PR) | なし                 |
| `unknown`     | plan のコメントはあるが形式を解釈できない。手動で確認する                                    | 不明                 |
| `failed`      | いずれかの project の最後の plan が失敗、または project に紐づかない失敗 (ロックなど)        | 不明                 |
| `changes`     | いずれかの project に変更がある                                                              | 列挙 / なし          |
| `no-changes`  | 全 project が変更なし                                                                        | なし                 |

## Atlantis

`atlantis-comment-author` を指定すると、次の手順で plan を集めます。

1. head commit に付く `atlantis/plan` の commit status (project ごとの `atlantis/plan: <dir>/<workspace>` ではなく集約のもの) が `pending` 以外になるまで待つ。`start-timeout` 内に status が付かなければ plan 無し (`none`)、description が `0/0 ` で始まれば対象 project なし (`no-projects`) とする
2. その status が head commit に最初に付いた時刻以降に `atlantis-comment-author` が投稿した plan コメントを集める。それより前のコメントは古い head に対する plan とみなして使わない
3. 分割されたコメント (`Continued plan output from previous comment.`) は前のコメントにつなぐ
4. project (`dir` / `workspace`、名前付き project は `project` も) ごとに最後の plan の結果を採用する。前の失敗は同じ project の後の plan で上書きされ、project に紐づかない失敗は後でいずれかの project の plan が出れば解消したものとする
5. plan 出力の `# <address> will be created` などの行から変更リソースを抽出する (data source の `read` は含めない)

変更リソースの action は `terraform plan -json` の語彙 (`create`, `update`, `delete`, `replace`, `import`, `move`, `forget`) に揃えています。

### 前提・注意事項

- Atlantis 既定のコメントテンプレートを前提にしている。テンプレートをカスタマイズしている場合や Atlantis の更新で形式が変わった場合は `unknown` になる (誤って「変更なし」にはしない)
- plan 出力が Atlantis 側で打ち切られた場合、打ち切られた部分のリソースは一覧に出ない
- Terraform に関係しない PR でも通常は `0/0 projects planned successfully.` の status がすぐ付くので待たない。status がまったく付かない PR では `start-timeout` 秒待ってから `none` になる
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
| `max-wait-time`           | plan の完了を待つ最大時間 (秒)。`0` なら待たずに 1 回だけ確認する                                                                      | No       | `600`                 |
| `start-timeout`           | head commit に plan の status が付くまで待つ時間 (秒)                                                                                  | No       | `120`                 |
| `poll-interval`           | ポーリング間隔 (秒)                                                                                                                    | No       | `10`                  |

## Outputs

| Name                      | Description                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `output-dir`              | 書き出し先ディレクトリの絶対パス                                 |
| `head-sha`                | コンテキストを取得した head commit の SHA                        |
| `diff-truncated`          | `pr-diff.patch` をファイルごとの patch から組み立てたか          |
| `plan-state`              | plan の状態 ([plan の状態](#plan-の状態-plan-state) を参照)      |
| `resource-count`          | 変更リソースの件数 (address と action で重複を除く)              |
| `has-destructive-changes` | destroy または replace されるリソースがあるか (`true` / `false`) |
