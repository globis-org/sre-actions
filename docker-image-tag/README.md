# docker-image-tag action

This action generates opinionated Docker image tags.

## How to use

```yaml
    steps:
      - name: Generate image tags
        id: tags
        uses: globis-org/sre-actions/docker-image-tag@6ba129bd5600ddc8365a235c9737fcbf125b758d # v1
        with:
          env: ${{ env.ENV }}
        env:
          TZ: Asia/Tokyo
```

## Outputs

1. **image_tag**: `${env}-${timestamp}-${commit hash or git tag}`
1. **latest_tag**: `${env}-latest`
