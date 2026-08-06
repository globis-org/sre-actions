import { parseArgs } from 'node:util'
import { run } from './checker'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', default: '.skill-policy.yaml' },
    format: { type: 'string', default: 'text' },
    strict: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
})

if (values.help) {
  console.log(`Usage: skill-frontmatter-linter [PATH] [OPTIONS]

Options:
  --config <path>   Policy config file (default: .skill-policy.yaml)
  --format <fmt>    Output format: text, github, json (default: text)
  --strict          Treat warnings as errors
  -h, --help        Show this help`)
  process.exit(0)
}

const fmt = values.format as 'text' | 'github' | 'json'
if (!['text', 'github', 'json'].includes(fmt)) {
  console.error(`Invalid format: ${values.format}`)
  process.exit(1)
}

const result = run({
  path: positionals[0] ?? '.',
  config: values.config!,
  format: fmt,
  strict: values.strict!,
})

if (result.output) {
  console.log(result.output)
}

process.exit(result.hasErrors ? 1 : 0)
