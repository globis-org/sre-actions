# PR Context

Pull Request のレビューに必要なコンテキスト (PR のメタデータ、diff、Atlantis または HCP Terraform の plan の結果) を集め、ファイルに書き出す GitHub Action です。

AI レビュー (claude-code-action など) の前段で実行し、レビューする側には集める作業をさせずに、書き出したファイルを読ませる使い方を想定しています。

- PR 情報と diff は同じ head commit に固定して取得する
- inline コメントを付けられる行は diff からコードで決める
- plan の状態と変更リソース一覧はコードで決め、LLM に列挙・判定させない

## 使用例

この action は plan の完了を待ちません。前段のジョブで [wait-for-commit-statuses](../wait-for-commit-statuses) (Atlantis) や [hcp-terraform-plan](../hcp-terraform-plan) (HCP Terraform) を使って待ちます。待機を軽い runner に置け、plan の結果でレビュー自体を skip する判断もレビューのジョブを起動する前にできるためです。

### Atlantis

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
      - uses: globis-org/sre-actions/wait-for-commit-statuses@v1
        with:
          context-names: atlantis/plan* # 集約 status と project ごとの status をまとめて待つ
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

### HCP Terraform

```yaml
jobs:
  wait-plan:
    runs-on: ubuntu-slim
    timeout-minutes: 20
    permissions:
      statuses: read
      pull-requests: read
    steps:
      - uses: globis-org/sre-actions/hcp-terraform-plan@v1
        with:
          token: ${{ secrets.HCP_TERRAFORM_TOKEN }}
          organization: my-org
          comment: false # コメントと gate は別の workflow で
        continue-on-error: true # plan が失敗してもレビューは続ける

  review:
    needs: [wait-plan]
    if: ${{ !cancelled() }}
    # ...
    steps:
      - uses: actions/checkout@v7

      - uses: globis-org/sre-actions/pr-context@v1
        with:
          hcp-terraform-token: ${{ secrets.HCP_TERRAFORM_TOKEN }}
          hcp-terraform-organization: my-org

      - uses: anthropics/claude-code-action@v1
        # ...
```

書き出し先 (`output-dir`、既定は `.claude-review`) はリポジトリの `.gitignore` に追加してください。

## 書き出すファイル

HCP Terraform では project = workspace です。

| ファイル                | 内容                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-info.json`          | PR のメタデータ。フィールド名は `gh pr view --json` に合わせる。`headRefOid` は action が起動した時点の head。`files` は最大 3,000 件 |
| `pr-diff.patch`         | base と head の SHA を固定した diff (`base...head`)                                                                                   |
| `commentable-lines.txt` | head 側で review comment を付けられる行 (hunk の中の追加行と前後の行)。1 行に 1 つ `<path>:<line>:<原文>` (下記)                      |
| `plan-summary.md`       | plan の状態、project の表、変更リソース一覧 (下記)。plan 収集時のみ                                                                   |
| `plan-details.md`       | project ごとの最新の plan 出力 (下記)。属性の変更内容を確かめる用途で、状態とリソースの正は `plan-summary.md`。plan 収集時のみ        |

### `commentable-lines.txt`

diff に無いファイルの行や hunk の外の行には review comment を付けられません。inline コメントの前に `grep -F '<path>:<line>:' commentable-lines.txt` で確かめます。末尾が同じ別のパスにも一致するので、出た行が `<path>:` で始まることも確かめてください。削除されたファイルとバイナリは含みません。

### `plan-summary.md`

先頭 3 行は位置と書式を固定しています (review-pr skill が行位置で読む)。

```
plan: 変更あり
destroy / replace: `aws_s3_bucket.old` (delete, infra-app-prod)
plan の詳細: 属性の差分あり

| project | 状態 | status | 理由 |
|---|---|---|---|
| infra-app-prod | 変更あり | Terraform plan: 1 to add, 0 to change, 1 to destroy. |  |

変更リソース一覧（2 件）:
- infra-app-prod: `aws_s3_bucket.new` create
- infra-app-prod: `aws_s3_bucket.old` delete
```

`plan の詳細:` は、変更のある project の plan 出力が `plan-details.md` にあれば `属性の差分あり`、無ければ `なし` です。

### `plan-details.md`

plan を実行した project ごとに、最新の plan だけを `## <project>` の節で出します (再 plan や前の失敗は含まない)。

- Atlantis と HCP Terraform の Console UI: `terraform plan` の出力
- HCP Terraform の Structured Run Output: diagnostic と、JSON plan から描画した `key: before -> after`
- 変更なしの project は `No changes.`、失敗した project はエラーの出力

## plan の状態 (`plan-state`)

| 値            | 意味                                                                                                                      | `destroy-or-replace` |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `disabled`    | plan を収集していない (`atlantis-comment-author` も `hcp-terraform-organization` も空、または `hcp-terraform-token` が空) | `unknown`            |
| `pending`     | plan が終わっていない project がある                                                                                      | `unknown`            |
| `none`        | head commit に plan の status が無い                                                                                      | `unknown`            |
| `no-projects` | 対象 project が無い (Terraform に関係しない PR)                                                                           | `false`              |
| `failed`      | plan が失敗した project がある                                                                                            | `unknown`            |
| `incomplete`  | 変更リソース一覧を確かめられない project がある (下記)。手動で確認する                                                    | `unknown`            |
| `changes`     | 変更のある project がある                                                                                                 | `true` / `false`     |
| `no-changes`  | 全 project が変更なし                                                                                                     | `false`              |

`failed` / `incomplete` / `pending` でも、確かめられた project に destroy / replace があれば `destroy-or-replace` は `true` です。

## 変更リソース一覧の作り方

|              | Atlantis                                                  | HCP Terraform                                                                    |
| ------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 状態         | project ごとの commit status (`atlantis/plan: <project>`) | workspace ごとの commit status (`Terraform Cloud/<org>/<workspace>`) と plan API |
| 変更リソース | plan コメントの `# <address> will ...` の行               | `json-output-redacted` (`terraform show -json` 相当) の `resource_changes`       |
| 照合する件数 | status の Plan 行                                         | plan API の件数                                                                  |

action は `terraform plan -json` の語彙 (`create` / `update` / `delete` / `replace` / `import` / `move` / `forget`) です。data source の `read` は含めません。import と同時に update されるリソースは `update` として出ます。

project は次のときに `incomplete` になります。出力の打ち切りや未知の書式で、黙って「destroy なし」と報告しないためです。

- 変更リソースの数が件数と合わない (add = create + replace、change = update、destroy = delete + replace。import / move / forget は件数に出ないので数えない)
- 解釈できない変更がある (Atlantis: address の直後に `will` などが続くのに解釈できない行。HCP Terraform: 知らない `actions` の組み合わせ)
- 材料を取れない (Atlantis: plan コメントが見つからない。HCP Terraform: API のエラー、JSON plan を取得できない)

### 注意事項

- Atlantis は既定のコメントテンプレートを前提にしている。カスタマイズしているとリソースを抽出できず `incomplete` になる
- HCP Terraform 側の VCS 設定で **Non-aggregated status checks** を有効にする (aggregated では workspace ごとの status が付かず `none` になる)
- HCP Terraform は status が付いた workspace だけを対象にする。speculative plan が無効で status が付かない workspace は見えない (merge の gate で止めるのは [hcp-terraform-plan](../hcp-terraform-plan) の責務)
- `hcp-terraform-token` には runs の read 権限を持つ team token を使う。fork からの PR では token が空になるので plan を収集せず、PR 情報と diff だけを書き出す
- `json-output-redacted` は API ドキュメントに無い endpoint (Terraform CLI が使っているもの)。変更のある workspace ごとに 1 回取る (数百 KB〜数 MB)
- `has-changes` が false の workspace は JSON plan を読まない。forget だけの plan がこれに当たるかは確かめていない
- HCP Terraform の Console UI の workspace は、実ログで検証していない

## Inputs

| Name                         | Description                                                                                                                                                  | Required | Default                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------- |
| `github-token`               | PR・コメント・commit status の読み取りに使う GitHub token                                                                                                    | No       | `${{ github.token }}`                     |
| `pull-request-number`        | Pull Request 番号                                                                                                                                            | No       | `${{ github.event.pull_request.number }}` |
| `output-dir`                 | 書き出し先ディレクトリ (作業ディレクトリからの相対パス)                                                                                                      | No       | `.claude-review`                          |
| `atlantis-comment-author`    | Atlantis が plan コメントを投稿する GitHub App のログイン名 (`[bot]` の有無は問わない)。`hcp-terraform-organization` とは排他                                | No       | -                                         |
| `hcp-terraform-token`        | HCP Terraform API token (run の read 権限を持つ team token)。`hcp-terraform-organization` 指定時に空なら plan を収集しない                                   | No       | -                                         |
| `hcp-terraform-organization` | HCP Terraform organization 名。指定すると HCP Terraform の speculative plan を収集する。`atlantis-comment-author` とは排他。どちらも空なら plan を収集しない | No       | -                                         |
| `hcp-terraform-hostname`     | HCP Terraform / Terraform Enterprise のホスト名                                                                                                              | No       | `app.terraform.io`                        |

## Outputs

| Name                 | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `output-dir`         | 書き出し先ディレクトリの絶対パス                                             |
| `head-sha`           | コンテキストを取得した head commit の SHA                                    |
| `plan-state`         | plan の状態 ([plan の状態](#plan-の状態-plan-state) を参照)                  |
| `resource-count`     | 変更リソースの数 (project / workspace ごとに数える)                          |
| `destroy-or-replace` | destroy または replace されるリソースがあるか (`true` / `false` / `unknown`) |
