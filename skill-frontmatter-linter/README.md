# skill-frontmatter-linter

Lint [Claude Code skill/command frontmatter](https://code.claude.com/docs/en/skills#frontmatter-reference) against GLOBIS SRE policy.

The known field list and validation rules target Claude Code's extended frontmatter. The [Agent Skills](https://agentskills.io/specification) open standard defines a smaller set of fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`); this linter does not cover Agent Skills-only fields. Set `allowUnknown: true` in the config if your skills use them.

## Checks

- YAML frontmatter is parseable
- Required fields exist (skill: `name`, `description`, `allowed-tools` / command: `description`, `allowed-tools`)
- `name` is kebab-case and is a string
- `name` matches the directory name
- Unknown frontmatter fields (based on [Claude Code frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference))
- `allowed-tools` entries are within the allowed list
- Comma-separated Bash specifiers (`Bash(git:*,terraform:*)` is invalid)
- Glob + `:*` combination (`Bash(*/foo.sh:*)` never matches)
- Broad Bash permissions (bare `Bash`, `Bash(*)`, `Bash(*:*)`, `Bash()`, `Bash(:*)`)
- MCP function format (`MCP(server:*)` is invalid)
- Unclosed parenthesis in tool specifiers (`Bash(git:*` missing `)`)
- Unsupported `allowed-tools` format (YAML block scalar `|`)
- Unclosed Markdown code fences

## GitHub Actions

```yaml
- uses: globis-org/sre-actions/skill-frontmatter-linter@vX.Y.Z
  with:
    path: '.'
    config: '.skill-policy.yaml'
    strict: 'true'
```

### Inputs

| Name     | Default              | Description                                  |
| -------- | -------------------- | -------------------------------------------- |
| `path`   | `.`                  | Root path to search for skills and commands  |
| `config` | `.skill-policy.yaml` | Policy config file path (relative to `path`) |
| `strict` | `false`              | Treat warnings as errors                     |

## Local usage

### mise remote task include (recommended)

Add to your repo's `mise.toml`:

```toml
[task_config]
includes = [
    'git::https://github.com/globis-org/sre-actions.git//skill-frontmatter-linter/tasks',
]
```

```bash
mise run lint-skills
```

## CLI

```bash
node dist/cli.js [PATH] [OPTIONS]

Options:
  --config <path>   Policy config file (default: .skill-policy.yaml)
  --format <fmt>    Output format: text, github, json (default: text)
  --strict          Treat warnings as errors
```

## Config

Place `.skill-policy.yaml` at the repository root:

```yaml
version: 1

discovery:
  claudeSkills:
    - .claude/skills
  claudeCommands:
    - .claude/commands
  pluginRoots:
    - claude-plugins

frontmatter:
  required:
    - description
    - allowed-tools
  skillRequired:
    - name
  allowUnknown: false

naming:
  directoryMustMatchName: true
  namePattern: '^[a-z0-9]+(-[a-z0-9]+)*$'
  maxNameLength: 64

tools:
  allowed:
    - Read
    - Grep
    - Glob
    - Bash
  requireJustification:
    - Bash
```

<!-- TODO: config validation with zod (z.toJsonSchema() for editor autocomplete
     via yaml-language-server $schema directive) -->

## Development

```bash
pnpm install
pnpm type-check
pnpm test                                    # jest (run from repo root)
pnpm --filter skill-frontmatter-linter package   # build dist/
```
