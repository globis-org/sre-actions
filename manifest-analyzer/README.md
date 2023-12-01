# manifest-analyzer action

This action performs diff detection and static analysis of the manifest configured in Kustomize.

## How to use

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          path: main
          ref: main

      - name: Lint manifests
        uses: globis-org/sre-actions/manifest-analyzer@v1
        with:
          base-dir: main/overlays/dev
          head-dir: overlays/dev
          k8s-version: v1.26.0
```
