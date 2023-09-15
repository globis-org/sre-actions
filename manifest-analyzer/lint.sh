#!/bin/bash
set -u

base_dir="$BASE_DIR"
head_dir="$HEAD_DIR"
version="$K8S_VERSION"

base_manifest=base.yaml
head_manifest=head.yaml
output_file=lint.md

function get_emoji() {
  if [[ $1 -eq 0 ]]; then
    echo ✅
  else
    echo 💥
  fi
}

format="v[0-9]+.[0-9]+.[0-9]+"

if [[ ! $version =~ $format ]]; then
  echo "Invalid version format: $version"
  exit 1
fi

minor_version=$(echo "$version" | cut -d. -f1-2)

kubeconform=$(cat "$head_manifest" | kubeconform -strict -output tap \
  -ignore-missing-schemas \
  -kubernetes-version "${version#v}" 2>&1) # remove prefix "v" from version
rc1=$?

kube_score=$(cat "$head_manifest" | kube-score score -o ci - \
  --ignore-test container-security-context-user-group-id \
  --ignore-test container-security-context-privileged \
  --ignore-test container-security-context-readonlyrootfilesystem \
  --ignore-test container-ephemeral-storage-request-and-limit \
  --ignore-test pod-probes \
  --kubernetes-version "$minor_version" 2>&1)
rc2=$?

pluto=$(cat "$head_manifest" | pluto detect - -o custom \
    --columns 'name,kind,version,replacement,deprecated in,removed in' \
    --target-versions k8s="$version" 2>&1)
rc3=$?

tee "$output_file" << EOS
### $(get_emoji $rc1) kubeconform [$head_dir]

<details><summary>show outputs</summary>

\`\`\`
$kubeconform
\`\`\`

</details>

### $(get_emoji $rc2) kube-score [$head_dir]

<details><summary>show outputs</summary>

\`\`\`
$kube_score
\`\`\`

</details>

### $(get_emoji $rc3) pluto [$head_dir]

<details><summary>show outputs</summary>

\`\`\`
$pluto
\`\`\`

</details>
EOS

echo "file=$output_file" >> "$GITHUB_OUTPUT"
echo "rc1_emoji=$(get_emoji $rc1)" >> "$GITHUB_OUTPUT"
echo "rc2_emoji=$(get_emoji $rc2)" >> "$GITHUB_OUTPUT"
echo "rc3_emoji=$(get_emoji $rc3)" >> "$GITHUB_OUTPUT"

if [[ $rc1 -ne 0 || $rc2 -ne 0 || $rc3 -ne 0 ]]; then
  echo "kubeconform, kube-score or pluto failed."
  exit 1
fi

echo "kubeconform, kube-score and pluto passed."
