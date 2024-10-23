#!/bin/bash
set -euo pipefail

pr_number="$PR_NUMBER"
json_path="$JSON_PATH"

# JSON 配列から改行区切りのテキストを生成する
cat "$json_path" | jq -r '.[]' | tee dirs.txt

if [[ ! -s dirs.txt ]]; then
  echo "No dirs to check"
  exit 0
fi

echo '以下のパスに `.terraform.lock.hcl` が存在しません。' > comment_body.md

committed=true
while read -r dir; do
  echo -n "Checking $dir ... "
  # ディレクトリが存在し、かつ .terraform.lock.hcl が存在しない場合はコミットされていないと判断
  if [[ -f "$dir/.terraform.lock.hcl" ]]; then
    echo "ok"
  elif [[ ! -d "$dir" ]]; then
    echo "skipped"
  else
    committed=false
    echo "- $dir" >> comment_body.md
    echo "not found"
  fi
done < dirs.txt

if [[ $committed == false ]]; then
  cat comment_body.md
  gh pr comment "$pr_number" --body-file comment_body.md
  exit 1
fi
