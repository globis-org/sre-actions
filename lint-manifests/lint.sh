#!/bin/bash

env="$ENV"
product="$PRODUCT"
version="$K8S_VERSION"
output_file=output.md

format="v[0-9]+.[0-9]+.[0-9]+"

if [[ ! $version =~ $format ]]; then
  echo "Invalid version format: $version"
  exit 1
fi

minor_version=$(echo "$version" | cut -d. -f1-2)

type kustomize
type kube-score
type kubeconform

if [ -z "$product" ]; then
  kustomize_path="overlays/$env"
else
  kustomize_path="$product/overlays/$env"
fi

echo "kustomize path: $kustomize_path"
echo "working directory: $(pwd)"

manifest=$(kustomize build "$kustomize_path" 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
  tee $output_file << EOS
### kustomize build [$kustomize_path]
\`\`\`
$manifest
\`\`\`
EOS
  exit 1
fi

echo "build manifests successfully."

kubeconform=$(echo "$manifest" | kubeconform -strict -output tap \
  -ignore-missing-schemas \
  -kubernetes-version "${version#v}" 2>&1) # remove prefix "v" from version
rc1=$?

kube_score=$(echo "$manifest" | kube-score score -o ci - \
  --ignore-test container-security-context-user-group-id \
  --ignore-test container-security-context-privileged \
  --ignore-test container-security-context-readonlyrootfilesystem \
  --ignore-test container-ephemeral-storage-request-and-limit \
  --ignore-test pod-probes \
  --kubernetes-version "$minor_version" 2>&1)
rc2=$?

tee $output_file << EOS
### kubeconform [$kustomize_path]

<details><summary>show outputs</summary>

\`\`\`
$kubeconform
\`\`\`

</details>

### kube-score [$kustomize_path]

<details><summary>show outputs</summary>

\`\`\`
$kube_score
\`\`\`

</details>
EOS

if [[ $rc1 -ne 0 || $rc2 -ne 0 ]]; then
  exit 1
fi

echo "kubeconform and kube-score passed."
