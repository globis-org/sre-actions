# sre-actions

[![CI](https://github.com/globis-org/sre-actions/actions/workflows/ci.yaml/badge.svg)](https://github.com/globis-org/sre-actions/actions/workflows/ci.yaml)

Custom GitHub Actions for GLOBIS SRE team.

> [!NOTE]
> This repository is primarily maintained for internal use by the GLOBIS SRE team.

- [aws-ssm-parameters](aws-ssm-parameters)
- [codeowners-validator](codeowners-validator)
- [deploybot](deploybot)
- [docker-image-tag](docker-image-tag)
- [manifest-analyzer](manifest-analyzer)
- [terraform-lockfile-checker](terraform-lockfile-checker)
- [wait-for-commit-status](wait-for-commit-status)
- [wait-for-commit-statuses](wait-for-commit-statuses)

## Usage

For stability and security reasons, we recommend pinning actions to a specific commit hash:

```yaml
# Commit hash (recommended for stability)
- uses: globis-org/sre-actions/docker-image-tag@ca8905141676246f228522972520a3b6cb9bedf8

# Version tags (v1, v1.0, v1.0.1 also available)
- uses: globis-org/sre-actions/docker-image-tag@v1
```

## Development

### Build Artifacts

You don't need to commit `dist/` build artifacts during development.

[tagpr](https://github.com/Songmu/tagpr) automatically builds all actions and includes the artifacts when creating a release PR.

```bash
pnpm install
pnpm all          # lint, format, test
pnpm -r run all   # build each action (for local testing, no commit needed)
```

### Release Process

This repository uses [tagpr](https://github.com/Songmu/tagpr) for automated releases:

1. Merge your changes to the `main` branch
2. tagpr automatically creates a release PR with:
   - Updated version in `package.json`
   - Generated `CHANGELOG.md`
   - Built artifacts (`dist/` directories) for all actions
3. Review and merge the release PR
4. tagpr automatically creates a Git tag and GitHub Release

Version tags (`v1`, `v1.0`, `v1.0.x`) are updated automatically to point to the latest releases.

### Dependency Updates

Dependencies are automatically updated by [Renovate](https://docs.renovatebot.com/). Check [renovate.json](renovate.json) for the configuration.
