# AGENTS.md

@README.md
@package.json

## 作業時の注意

- corepack は使わない。pnpm のバージョンは `package.json` の `packageManager` を直接編集する。

## public リポジトリ

コード、テスト、コメント、コミットメッセージ、PR、Issue のすべてが公開される。private リポジトリ名、社内チーム名や実在ユーザーのログイン名、Slack や Notion などの社内 URL、アカウント ID やホスト名などの環境識別子は書かない。例やテストのフィクスチャは `@org/team` や `infra/app/settings.yaml` のような汎用名にする。既存の違反を見つけたら黙って直さずユーザーに指摘する。
