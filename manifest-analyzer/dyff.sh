#!/bin/bash
set -u

base_dir="$BASE_DIR"
head_dir="$HEAD_DIR"

base_manifest=base.yaml
head_manifest=head.yaml
output_file=dyff.md

function get_emoji() {
  if [[ $1 -eq 0 || $1 -eq 1 ]]; then
    echo ✅
  else
    echo 💥
  fi
}

function get_message() {
  if [[ $1 -eq 0 ]]; then
    echo "no changes detected 🎉"
  elif [[ $1 -eq 1 ]]; then
    echo "some changes detected 👀"
  else
    echo "dyff failed"
  fi
}

diff_output=""
if [[ -s "$base_manifest" ]]; then
  diff_output=$(dyff between "$base_manifest" "$head_manifest" --color off --set-exit-code 2>&1)
else
  echo "base manifest not found or empty."
  touch "$base_manifest"
  diff_output=$(diff "$base_manifest" "$head_manifest" --unified 2>&1)
fi
rc=$?

tee "$output_file" << EOS
### $(get_emoji $rc) dyff [$head_dir]

\`\`\`
$(get_message $rc)
\`\`\`

<details><summary>show outputs</summary>

\`\`\`diff
$diff_output
\`\`\`

</details>
EOS

echo "file=$output_file" >> "$GITHUB_OUTPUT"
echo "rc_emoji=$(get_emoji $rc)" >> "$GITHUB_OUTPUT"

if [[ $rc -ne 0 && $rc -ne 1 ]]; then
  echo "dyff failed."
  exit 1
fi

echo "dyff passed."
