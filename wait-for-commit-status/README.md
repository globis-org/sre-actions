# Wait for Commit Status

任意のコミットステータスチェックの完了を待機する汎用的な GitHub Action です。

## 概要

この Action は、GitHub の Commit Status API を使用して、指定されたチェックの完了を待ちます。
Atlantis、CI/CD パイプライン、外部チェックなど、あらゆるコミットステータスに対応しています。

## 機能

- ✅ 任意のコミットステータスチェックを待機
- 🔄 カスタマイズ可能なポーリング間隔
- ⏱️ タイムアウト設定（タイムアウト時の動作も制御可能）
- 📊 詳細なステータス出力（status、description、timed-out）
- 🔍 デバッグ用のログ出力

## 使用方法

### 基本的な使い方

```yaml
- name: Wait for Atlantis plan
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'atlantis/plan'
```

### カスタマイズした使い方

```yaml
- name: Wait for CI check
  id: wait-ci
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'ci/test'
    max-wait-time: '1800' # 30分
    poll-interval: '5' # 5秒ごとにチェック
    fail-on-timeout: 'false' # タイムアウトしてもエラーにしない

- name: Check result
  run: |
    echo "Status: ${{ steps.wait-ci.outputs.status }}"
    echo "Description: ${{ steps.wait-ci.outputs.description }}"
    echo "Timed out: ${{ steps.wait-ci.outputs.timed-out }}"
```

## Inputs

| Name              | Description                                                                | Required | Default        |
| ----------------- | -------------------------------------------------------------------------- | -------- | -------------- |
| `check-name`      | 待機するコミットステータスチェックの名前（例: `atlantis/plan`, `ci/test`） | Yes      | -              |
| `max-wait-time`   | 最大待機時間（秒）                                                         | No       | `3600` (1時間) |
| `poll-interval`   | ポーリング間隔（秒）                                                       | No       | `10`           |
| `fail-on-timeout` | タイムアウト時にアクションを失敗させるか                                   | No       | `true`         |

## Outputs

| Name          | Description              | Example                                                          |
| ------------- | ------------------------ | ---------------------------------------------------------------- |
| `status`      | チェックの最終ステータス | `success`, `failure`, `error`, `pending`, `not_found`, `unknown` |
| `description` | ステータスの説明文       | チェックが提供する説明文                                         |
| `timed-out`   | タイムアウトしたかどうか | `true` または `false`                                            |

### ステータスの種類

- `success`: チェックが成功
- `failure`: チェックが失敗
- `error`: チェックでエラーが発生
- `pending`: チェックが実行中（待機中）
- `not_found`: チェックが見つからない
- `unknown`: 初期状態または予期しない状態

## ユースケース

### Atlantis の plan 完了を待つ

```yaml
- name: Wait for Atlantis plan
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'atlantis/plan'
    max-wait-time: '1800'
```

### 複数のチェックを順番に待つ

```yaml
- name: Wait for build
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'ci/build'

- name: Wait for tests
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'ci/test'
```

### タイムアウトしても続行する

```yaml
- name: Wait for optional check
  id: wait-optional
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'ci/optional-check'
    max-wait-time: '600'
    fail-on-timeout: 'false'

- name: Handle timeout
  if: steps.wait-optional.outputs.timed-out == 'true'
  run: echo "Optional check timed out, continuing anyway"
```

### ステータスに応じて条件分岐

```yaml
- name: Wait for deployment check
  id: wait-deploy
  uses: globis-org/sre-actions/wait-for-commit-status@main
  with:
    check-name: 'deploy/staging'

- name: Notify on success
  if: steps.wait-deploy.outputs.status == 'success'
  run: echo "Deployment succeeded!"

- name: Notify on failure
  if: steps.wait-deploy.outputs.status == 'failure'
  run: echo "Deployment failed!"
```

## 注意事項

- この Action は `pull_request` イベントでのみ使用できます
- GitHub Commit Status API を使用するため、Check Runs API を使用するチェックには対応していません
- 同じ名前のステータスが複数ある場合、最新のもの（最後に作成されたもの）を使用します

## ライセンス

MIT
