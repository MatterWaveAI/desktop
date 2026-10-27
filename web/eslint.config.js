// The PR gate's web lint. Minimal and standard -- the vite react-ts
// template config (eslint 9 flat config), nothing invented here:
//   @eslint/js recommended + typescript-eslint recommended over **/*.ts,tsx,
//   react-hooks recommended (stale-hook bugs are invisible until runtime),
//   react-refresh only-export-components as a warning (fast-refresh purity).
// If a rule here blocks a legitimate pattern, change the rule in this file
// with a comment -- do not inline-disable app code from CI config.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config([
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // The vendored shadcn-on-Base-UI set exports its cva
    // variants beside each component. That is the upstream shape, and
    // rewriting it would make the next `shadcn add` conflict. The rule only
    // affects dev-time fast refresh, never the build, so it is scoped off here
    // rather than worked around inside vendor files.
    files: ['src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
