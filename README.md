# sre-actions
Custom GitHub Actions for SRE

## How to use composite actions

### Run CodeBuild

```yaml
permissions:
  id-token: write
  contents: read
  actions: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Run CodeBuild
        uses: globis-org/sre-actions/run-codebuild@v1
        with:
          slack-oauth-token: ${{ secrets.SRE_SLACK_OAUTH_TOKEN }}
          slack-channel: ${{ env.SLACK_CHANNEL }}
          role-to-assume: ${{ env.ROLE_TO_ASSUME }}
          codebuild-project: ${{ env.CODEBUILD_PROJECT }}
```

### Run CodeBuild and build docker image

```yaml
permissions:
  id-token: write
  contents: read
  actions: read

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        ecr_repository: ["product", "product-bastion"]
    steps:
      - name: Build image
        uses: globis-org/sre-actions/run-codebuild-and-build-image@v1
        with:
          slack-oauth-token: ${{ secrets.SRE_SLACK_OAUTH_TOKEN }}
          slack-channel: ${{ env.SLACK_CHANNEL }}
          role-to-assume: ${{ env.ROLE_TO_ASSUME }}
          tag-env: ${{ env.ENV }}
          codebuild-project: ${{ env.CODEBUILD_PROJECT }}
          ecr-repository: ${{ matrix.ecr_repository }}
```
