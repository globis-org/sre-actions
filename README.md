# sre-actions
GitHub Actions for GLOBIS SRE team

- [aws-ssm-parameters](aws-ssm-parameters)
- [codeowners-validator](codeowners-validator)
- [deploybot](deploybot)
- [docker-image-tag](docker-image-tag)
- [manifest-analyzer](manifest-analyzer)
- [terraform-lockfile-checker](terraform-lockfile-checker)

## Usage

For stability and security reasons, we recommend pinning actions to a specific commit hash:

```yaml
- uses: globis-org/sre-actions/docker-image-tag@a8c95d7b2e8f9c4e7f52ad53e2a06b384d23f7ca
```

Major version tags (`v1`, `v2`) are available but commit SHAs are preferred for production use.

## Development

### Build Artifacts

You don't need to commit `dist/` build artifacts during development.

[tagpr](https://github.com/Songmu/tagpr) automatically builds all actions and includes the artifacts when creating a release PR.

```bash
pnpm install
pnpm all          # lint, format, test
pnpm -r run all   # build each action (for local testing, no commit needed)
```
