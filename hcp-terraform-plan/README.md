# HCP Terraform Plan

VCS 連携された HCP Terraform workspace が Pull Request に対して実行する speculative plan の結果を待ち、PR コメントとして投稿する GitHub Action です。

HCP Terraform は PR の head commit に `Terraform Cloud/<org>/<workspace>` という commit status を付けます。この action はその status を監視し、run が完了したら HCP Terraform API から plan の内容を取得して、1 つの sticky コメントにまとめます。GitHub Actions 側で run を作成することはありません (run の実行主体は HCP Terraform のまま)。

`status-context` を指定すると、plan の結果と review の状態から merge を制御するための commit status (gate) も作成します。詳細は [merge gate](#merge-gate) を参照してください。

## 使用例

```yaml
on:
  pull_request:
  pull_request_review: # gate を使う場合。types を絞らないこと (submitted / edited / dismissed すべてで再評価が必要)

# 同じ PR の run が並行すると、古い run が新しい判定を上書きしうる (approve 直後の dismiss など) ので必ず直列化する
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  statuses: write # gate を使わない場合は read
  pull-requests: write

jobs:
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Wait for HCP Terraform plans and comment
        id: plan
        uses: globis-org/sre-actions/hcp-terraform-plan@v1
        with:
          token: ${{ secrets.HCP_TERRAFORM_TOKEN }}
          organization: my-org
          status-context: hcp-terraform/plan

      - name: Check results
        run: |
          echo "Status: ${{ steps.plan.outputs.status }}"
          echo "Has changes: ${{ steps.plan.outputs.has-changes }}"
```

対象 workspace を明示する場合:

```yaml
with:
  token: ${{ secrets.HCP_TERRAFORM_TOKEN }}
  organization: my-org
  workspaces: |
    infra-app-prod
    infra-app-stg
```

## Inputs

| Name                  | Description                                                                     | Required | Default                                   |
| --------------------- | ------------------------------------------------------------------------------- | -------- | ----------------------------------------- |
| `token`               | HCP Terraform API token (run と workspace の read 権限を持つ team token)        | Yes      | -                                         |
| `organization`        | HCP Terraform organization 名                                                   | Yes      | -                                         |
| `hostname`            | HCP Terraform / Terraform Enterprise のホスト名                                 | No       | `app.terraform.io`                        |
| `workspaces`          | 待機する workspace 名 (カンマ区切りまたは改行区切り)。省略時は API から自動検出 | No       | -                                         |
| `github-token`        | commit status の読み取りと PR コメントの投稿に使う GitHub token                 | No       | `${{ github.token }}`                     |
| `pull-request-number` | Pull Request 番号                                                               | No       | `${{ github.event.pull_request.number }}` |
| `max-wait-time`       | 最大待機時間 (秒)                                                               | No       | `900`                                     |
| `poll-interval`       | ポーリング間隔 (秒)                                                             | No       | `10`                                      |
| `fail-on-timeout`     | タイムアウト時にエラーにするか                                                  | No       | `true`                                    |
| `fail-on-error`       | いずれかの run が errored のときエラーにするか                                  | No       | `true`                                    |
| `comment`             | PR コメントを投稿 (更新) するか                                                 | No       | `true`                                    |
| `show-untriggered`    | run が trigger されなかった workspace もコメントに含めるか                      | No       | `false`                                   |

## Outputs

| Name          | Description                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | `success`, `failure`, または `pending`                                                                                          |
| `has-changes` | いずれかの plan に変更があるか (`true` / `false`)                                                                               |
| `results`     | workspace ごとの結果の JSON 配列 (`workspace`, `status`, `runId`, `runUrl`, `hasChanges`, `add`, `change`, `destroy`, `import`) |
| `comment-id`  | 作成または更新した PR コメントの ID                                                                                             |

## コメントの内容

1 つの PR につき 1 つのコメントを作成し、以降は同じコメントを更新します。

- workspace ごとの結果を表にまとめる (status, add / change / destroy / import の件数, HCP Terraform の run へのリンク)
- workspace ごとに `<details>` で plan の詳細を折りたたんで表示
- errored の run は診断メッセージ (diagnostic) を表示
- GitHub のコメント上限 (65,536 文字) を超える場合は詳細を打ち切り、run へのリンクのみ残す

### plan 詳細の粒度

workspace の **User Interface** 設定によって取得できる plan ログの形式が変わり、コメントに載せられる粒度も変わります。

| 設定                               | ログ形式                    | コメントに載る詳細                         |
| ---------------------------------- | --------------------------- | ------------------------------------------ |
| Structured Run Output (デフォルト) | `terraform plan -json` 相当 | リソース単位の変更一覧 (address と action) |
| Console UI                         | `terraform plan` のテキスト | 属性レベルの差分を含む plan 全文           |

action はログの形式を自動判別するため、属性レベルの差分を PR で確認したい workspace は Console UI に切り替えるだけで対応できます。コードや token の権限を変える必要はありません。

## Merge gate

`status-context` を指定すると、head commit に次のルールで commit status を付けます。branch protection の required status checks に登録することで、「plan に diff がなければ bot の approve だけで merge できる (Renovate の automerge)、diff があれば人間の approve が必要」という制御ができます。

| 条件                                                                                                                                 | state     |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| いずれかの run が errored、タイムアウト、または plan を取得できない                                                                  | `failure` |
| 判定対象に入っていない workspace の status が commit に付いている (token から見えない project の workspace、`workspaces` の指定漏れ) | `failure` |
| VCS 連携されているが speculative plan が無効な workspace がある (diff を確認できない)                                                | `failure` |
| いずれかの plan に diff があり、bot 以外の APPROVED review がない                                                                    | `pending` |
| 上記以外 (diff なし、または人間が approve 済み)                                                                                      | `success` |

- PR の author は見ません。見るのは「approve したのが bot でなく、repository に write 権限以上を持つ人か」だけです (branch protection が数える approve と同じ条件)。Renovate PR でも人間が approve すれば `success` になります
- Terraform の workspace を 1 つも trigger しない PR (workflow ファイルだけの変更など) は `success` になります。この gate が守るのは Terraform の diff だけです
- approve した人に資格があるか (CODEOWNERS) は判定しません。それは branch protection や [codeowners-validator](../codeowners-validator) の責務で、両方を required にして組み合わせる前提です
- review の追加・取り消しで再評価するために、`pull_request` に加えて `pull_request_review` イベントでも実行してください
- HCP Terraform の workspace が auto-apply の場合、この status の登録漏れは「diff のある Renovate PR が自動 merge → apply される」ことを意味します。Renovate の automerge を有効にする前に required check の登録を確認してください
- `target_url` は PR コメント (コメント無効時は workflow run) を指します

## 前提・注意事項

- 対象 workspace が VCS 連携され、speculative plan が有効 (`speculative-enabled: true`) であること。自動検出では speculative plan が無効な workspace は待機対象から外れ (warning)、gate 有効時は `failure` になる
- 自動検出は VCS 連携先リポジトリが一致し、追跡ブランチが未設定または PR の base と一致する workspace を対象にする。token から見えない project の workspace は検出できないが、その workspace の status が commit に付いていれば gate は `failure` にする
- HCP Terraform 側の VCS 設定で **Non-aggregated status checks** が有効であること (aggregated の場合は workspace 単位の status が付かず、run へのリンクも得られない)
- `token` には HCP Terraform の team token を使う。必要な権限は run の read と、`workspaces` を省略する場合は workspace の read
- `pull_request` / `pull_request_review` イベントでのみ使用可能
- fork からの PR では secrets を参照できないため動作しない
