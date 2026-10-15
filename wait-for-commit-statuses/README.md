# Wait for Commit Statuses

複数のコミットステータスの完了を待機する GitHub Action です。

## 使用例

```yaml
- name: Wait for commit statuses
  id: wait
  uses: globis-org/sre-actions/wait-for-commit-statuses@main
  with:
    context-names: |
      atlantis/plan*
      ci/test
      build/production
    max-wait-time: '600'
    poll-interval: '10'

- name: Check results
  run: |
    echo "Status: ${{ steps.wait.outputs.status }}"
    echo "Timed out: ${{ steps.wait.outputs.timed-out }}"
    echo "Succeeded: ${{ steps.wait.outputs.succeeded-count }}"
    echo "Failed: ${{ steps.wait.outputs.failed-count }}"
```

## コンテキスト名の書き方

- 末尾が `*` なら前方一致、それ以外は完全一致
- 例: `atlantis/plan*` は `atlantis/plan` と `atlantis/plan: infra/app/stg/default` の両方に一致する。Atlantis の集約 status と project ごとの status をまとめて待つときに使う

## 完了と結果

次の両方を満たしたときに「完了」として待機を終える。

- 完全一致の名前がすべて存在し、前方一致はそれぞれ 1 件以上一致する
- 対象の status の最新の state に `pending` が無い

`failure` / `error` があっても、`pending` が残っている間は待ち続ける。完了の時点の結果 (`status`) は、`failure` / `error` が 1 つでもあれば `failure`、すべて `success` なら `success`。

## Inputs

| Name              | Description                                                                   | Required | Default |
| ----------------- | ----------------------------------------------------------------------------- | -------- | ------- |
| `context-names`   | 待機するコンテキスト名（カンマ区切りまたは改行区切り。末尾の `*` で前方一致） | Yes      | -       |
| `max-wait-time`   | 最大待機時間（秒）                                                            | No       | `3600`  |
| `poll-interval`   | ポーリング間隔（秒）                                                          | No       | `10`    |
| `fail-on-timeout` | タイムアウト時にエラーにするか                                                | No       | `true`  |

## Outputs

| Name              | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `status`          | `success`, `failure`, または `pending`（タイムアウト時は `pending`） |
| `timed-out`       | タイムアウトしたか（`true` / `false`）                               |
| `pending-count`   | pending 状態のステータス数                                           |
| `failed-count`    | 失敗したステータス数                                                 |
| `succeeded-count` | 成功したステータス数                                                 |

## 注意事項

- `pull_request` イベントでのみ使用可能
- GitHub Commit Status API を使用（Check Runs API には非対応）
- [combined status の API](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference) をページングして、コンテキストごとの最新の status で判定する
- 同じ commit で複数の実行が重なると、どの status も一瞬 `pending` でなくなる窓がありうる。例えば Atlantis の plan が二重に起動し、後の plan がロック衝突で集約 status を `failure` にしてから、先の plan が project ごとの status を `pending` で付けるまでの数秒間。この間にポーリングすると、実行の途中で `failure` として完了する。後段で結果を使うときは、status の description やコメントからこの状況を判別できるようにしておく（`pr-context` は `(全体)` 行にロック衝突の理由を出す）
