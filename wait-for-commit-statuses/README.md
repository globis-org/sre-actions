# Wait for Commit Statuses

複数のコミットステータスの完了を待機する GitHub Action です。

## 使用例

```yaml
- name: Wait for commit statuses
  id: wait
  uses: globis-org/sre-actions/wait-for-commit-statuses@main
  with:
    context-names: |
      atlantis/plan
      ci/test
      build/production
    max-wait-time: '600'
    poll-interval: '10'

- name: Check results
  run: |
    echo "Status: ${{ steps.wait.outputs.status }}"
    echo "Succeeded: ${{ steps.wait.outputs.succeeded-count }}"
    echo "Failed: ${{ steps.wait.outputs.failed-count }}"
```

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `context-names` | 待機するコンテキスト名（カンマ区切りまたは改行区切り） | Yes | - |
| `max-wait-time` | 最大待機時間（秒） | No | `3600` |
| `poll-interval` | ポーリング間隔（秒） | No | `10` |
| `fail-on-timeout` | タイムアウト時にエラーにするか | No | `true` |

## Outputs

| Name | Description |
|------|-------------|
| `status` | `success`, `failure`, または `pending` |
| `pending-count` | pending 状態のステータス数 |
| `failed-count` | 失敗したステータス数 |
| `succeeded-count` | 成功したステータス数 |

## 注意事項

- `pull_request` イベントでのみ使用可能
- GitHub Commit Status API を使用（Check Runs API には非対応）
- 同じコンテキスト名のステータスが複数ある場合、最新のものを使用
