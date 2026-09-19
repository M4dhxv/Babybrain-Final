import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// Build gate: only the rule that turns a page into "This page didn't load" (a
// hook called after an early return changes the hook count between renders and
// React throws). The full `npm run lint` config has many unrelated findings, so
// it is not a gate; this one is.
export default [
  { ignores: ['dist/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
]
