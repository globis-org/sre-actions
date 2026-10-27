# PR Context

Pull Request のレビューに必要なコンテキスト (PR のメタデータ、diff、Atlantis または HCP Terraform の plan の結果) を集め、ファイルに書き出す GitHub Action です。

AI レビュー (claude-code-action など) の前段で実行し、レビューする側には集める作業をさせずに、書き出したファイルを読ませる使い方を想定しています。

- PR 情報と diff は同じ head commit に固定して取得する
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

| ファイル          | 内容                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-info.json`    | PR のメタデータ。フィールド名は `gh pr view --json` に合わせる (`number`, `title`, `body`, `author`, `headRefName`, `headRefOid`, `files[].path` など)。`files` は API の上限で最大 3,000 件                                                                                                                                        |
| `pr-diff.patch`   | base と head の SHA を固定した diff (`base...head`)                                                                                                                                                                                                                                                                                 |
| `plan-summary.md` | 固定の 3 行 (`plan:` / `destroy / replace:` / `plan の詳細:`)、project の表、変更リソース一覧。レビューの prompt やサマリーにそのまま貼る用途 (plan 収集時のみ。HCP Terraform では project = workspace)                                                                                                                             |
| `plan-details.md` | plan を実行した project (未実行・未完了を除く) ごとの最新の plan 出力 (`## <project>` の節ごと。変更なしの project は `No changes.`、失敗した project はエラー出力。再 plan や前の失敗は含まない)。変更のある project があるかを `plan-summary.md` の 3 行目に示す (下記)。状態とリソースの正は `plan-summary.md` (plan 収集時のみ) |

### `plan-summary.md` の形式

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

3 行目の `plan の詳細:` は `plan-details.md` で属性の変更内容まで確認できるかを示します。

| 値               | 意味                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `属性の差分あり` | 変更のある project の plan 出力が `plan-details.md` にある。Atlantis と HCP Terraform の Console UI は `terraform plan` の出力、HCP Terraform の Structured Run Output は JSON plan から描画した `key: before -> after` の一覧 |
| `なし`           | `plan-details.md` に変更のある project の節が無い (変更なし、plan 未完了、plan 無し、失敗のみなど)                                                                                                                             |

Structured Run Output の workspace の属性の差分は、HCP Terraform の `json-output-redacted` から取ります ([HCP Terraform の結果の組み立て方](#hcp-terraform-の結果の組み立て方) を参照)。

## plan の状態 (`plan-state`)

| 値            | 意味                                                                                                                                        | `destroy-or-replace` |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `disabled`    | `atlantis-comment-author` も `hcp-terraform-organization` も空で、plan を収集していない                                                     | `unknown`            |
| `pending`     | plan が終わっていない (Atlantis: project の status に pending が残っている場合も含む。HCP Terraform: run が終わっていない workspace がある) | `unknown`            |
| `none`        | head commit に plan の status が無い (`atlantis/plan`、または `Terraform Cloud/<org>/` の status)                                           | `unknown`            |
| `no-projects` | 対象 project が無い (Atlantis: `0/0 projects planned`。HCP Terraform: 全 workspace が trigger されなかった。Terraform に関係しない PR)      | `false`              |
| `failed`      | いずれかの project の plan が失敗した                                                                                                       | `unknown`            |
| `incomplete`  | 変更リソース一覧を検証できない project がある (下記)。手動で確認する                                                                        | `unknown`            |
| `changes`     | いずれかの project に変更がある                                                                                                             | `true` / `false`     |
| `no-changes`  | 全 project が変更なし                                                                                                                       | `false`              |

`failed` / `incomplete` / `pending` (Atlantis で project の status が残っている場合、HCP Terraform で一部の workspace が終わっている場合) でも、検証できた project の destroy / replace が見つかれば `destroy-or-replace` は `true` になります。

## Atlantis の結果の組み立て方

状態は commit status から、変更リソースと失敗の理由はコメントから取ります。

1. head commit の集約 status (`atlantis/plan`) を読む。無ければ `none`、`pending` なら `pending`、description が `0/0 ` で始まれば `no-projects`
2. project ごとの status (`atlantis/plan: <dir>/<workspace>`、名前付き project は `atlantis/plan: <project>`) の最新を、その project の結果とする。description は Plan 行、`No changes.`、または失敗。いずれかの最新が `pending` なら、集約 status が `failure` でも `pending` とする (同じ commit で plan が重なり、後の plan がロック衝突で先に失敗した場合など)。このときも project の表と `(全体)` 行 (失敗の理由) は出す
3. 集約 status が head に最初に付いた時刻以降に、`atlantis-comment-author` (GitHub App) が投稿した plan コメントを集める。それより前は古い head への plan として使わない。分割された続き (`Continued plan output ...`) は前のコメントにつなぐ
4. コメントを project ごとの節に分け、project ごとに最後の節から次を取る
   - 変更リソース: `# <address> will be created` などの行 (data source の `read` は含めない)。action は `terraform plan -json` の語彙 (`create` / `update` / `delete` / `replace` / `import` / `move` / `forget`)。`removed` ブロックの `# <address> will no longer be managed by Terraform, but will not be destroyed` は `forget`
   - 解釈できない行: `# <address> will ...` のように address の直後に `will` / `must` / `is` / `has` が続くのに、上のどれにも当たらない行 (Terraform の新しい表示など)。plan の前の drift の報告 (`has changed` / `has been deleted`) と data source の `read` は除く
   - 失敗の理由: `**Plan Failed**: <理由>` の同じ行、無ければ後続の Terraform の診断行 (`│ Error: <summary>`)、それも無ければ HTML タグ行とコードフェンスを飛ばした最初の行
5. 変更リソースの数を status の Plan 行と突き合わせる (add = create + replace、change = update、destroy = delete + replace)。合わない、解釈できない行がある、またはコメントが見つからない project は `incomplete` にする。出力の打ち切り、コメントの欠落 (折りたたみ・削除)、未知の書式で、黙って「destroy なし」と報告しないため

### 注意事項

- import と同時に update されるリソースは `update` として一覧に出る (Terraform の表示が `(imported from ...)` を併記する形のため)。import の数は突き合わせに使わない
- forget の数は Plan 行に出ないことがある (`removed` ブロックだけの plan でも `Plan: 0 to add, 0 to change, 0 to destroy.`) ので、突き合わせに使わない。forget の行を取りこぼした場合は、解釈できない行として `incomplete` になる
- コメントが status より後に投稿された場合に備え、コメントが見つからない project があれば 5 秒おきに 3 回まで取り直す
- Atlantis 既定のコメントテンプレートを前提にしている。カスタマイズしている場合はリソースを抽出できず `incomplete` になる

## HCP Terraform の結果の組み立て方

状態と run は commit status から、件数と変更リソースは HCP Terraform API から取ります。

1. head commit の `Terraform Cloud/<organization>/<workspace>` の status を workspace ごとに最新のものに絞る。1 つも無ければ `none`。workspace の自動検出はせず、status が付いた workspace だけを対象にする (speculative plan が無効で status が付かない workspace は見えない。それを merge の gate で止めるのは [hcp-terraform-plan](../hcp-terraform-plan) の責務)
2. status の state と `target_url` (run へのリンク) から workspace ごとの結果を決める。`pending` なら「未完了」、run へのリンクが無い `success` は「未実行」(trigger されなかった)、`failure` / `error` は失敗
3. 終わった run は plan API (`/runs/<id>/plan`) から `has-changes` と件数 (add / change / destroy) を取る。`has-changes` が false なら「変更なし」とし、JSON plan もログも読まない
4. 変更があれば `GET /plans/<id>/json-output-redacted` (`terraform show -json` 相当。sensitive な値はハッシュ化済み) を取り、`resource_changes` の `actions` から変更リソースを作る。workspace の User Interface 設定 (Structured Run Output / Console UI) によらず同じ形なので、ログの形式に関係なくこれを正にする
   - 変更リソース: `create` / `update` / `delete` / `replace` (`delete,create` と `create,delete`) / `forget`、`no-op` に `importing` が付いたものは `import`、`previous_address` が付いたものは `move`。data source の `read` と、それ以外の `no-op` は含めない
   - 解釈できない `actions` の組み合わせがあれば、件数が合っていても `incomplete` にする (理由に `未知の action: <address> (<actions>)`)
   - 取得できない workspace は `incomplete` にする (変更リソースは空)
5. 変更リソースの数を plan API の件数と突き合わせる (add = create + replace、change = update、destroy = delete + replace)。合わない workspace は `incomplete` にする
6. `log-read-url` の plan ログを、`plan-details.md` の描画と失敗の理由のためだけに読む。Console UI (テキスト) のログは plan 本体をそのまま、Structured Run Output (`terraform plan -json` 相当) のログは diagnostic と、JSON plan から描画した `key: before -> after` を出す。ログを取得できなければ warning を出し、JSON plan から描画する
   - 失敗の理由: error の diagnostic、無ければ `Error: <summary>` 行、それも無ければ末尾の `Operation failed: ...`

### 注意事項

- import と同時に update されるリソースは `update` として一覧に出る (JSON plan では actions が `update` のまま `importing` が付く)。import / move / forget は plan API の件数に含まれないため突き合わせに使わない
- `has-changes` が false の workspace は JSON plan を読まないので、forget だけの plan で `has-changes` が false になる場合は、forget が一覧に出ない (未確認)
- HCP Terraform API の認証・権限エラーでも action は失敗させず、その workspace を `incomplete` にして warning を出す (レビュー自体は続ける)
- HCP Terraform 側の VCS 設定で **Non-aggregated status checks** が有効であること (aggregated の場合は workspace 単位の status が付かず、`none` になる)
- `hcp-terraform-token` には run の read 権限を持つ team token を使う。fork からの PR では secrets を参照できず token が空になるが、その場合は warning を出して plan を収集せず (`plan-state` は `disabled`)、PR 情報と diff は書き出す
- `json-output-redacted` は API ドキュメントに無い endpoint だが、Terraform CLI が Structured Run Output の描画に使っているもの。文書化されている `json-output` は workspace の admin 権限が必要で、state の値をそのまま含むため使わない。redacted は runs の read 権限で取れる (team token で確認済み)。サイズは数百 KB〜数 MB で、変更のある workspace ごとに 1 回取る
- plan ログの解釈と HCP Terraform API のクライアントは [hcp-terraform-plan](../hcp-terraform-plan) と同等のものを pr-context 内に持つ (action ごとに自己完結させるため共有しない)。解釈を直すときは両方を見る
- Console UI の workspace の plan ログは、`plan-details.md` に plan 本体として出すだけで解釈しない。手元の環境に Console UI の workspace が無いため、実ログでの検証は structured のみ

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
