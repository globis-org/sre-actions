import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['dist', 'lib']
  },
  {
    languageOptions: {
      globals: globals.node
    }
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
)
