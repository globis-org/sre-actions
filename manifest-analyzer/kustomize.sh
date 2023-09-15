#!/bin/bash
set -eu

base_dir="$BASE_DIR"
head_dir="$HEAD_DIR"

base_manifest=base.yaml
head_manifest=head.yaml

echo "kustomize base directory: $base_dir"
echo "kustomize head directory: $head_dir"
echo "working directory: $(pwd)"

if [[ -d "$base_dir" ]]; then
  kustomize build "$base_dir" > "$base_manifest"
else
  touch "$base_manifest"
fi

if [[ -d "$head_dir" ]]; then
  kustomize build "$head_dir" > "$head_manifest"
else
  echo "head directory not found: $head_dir"
  exit 1
fi

echo "build manifests successfully."
