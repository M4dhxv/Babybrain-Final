import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/* Deliberately narrow: the one rule that turns a page into "This page didn't
 * load" is a hook called after an early return (the hook count changes between
 * the loading render and the loaded render, and React throws). That is
 * deterministic, ships silently, and hits every visitor, so it fails the build.
 * Style and dependency-array rules are off on purpose. */
export default [
  { ignores: ["dist/**", "design-source*/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    // The typescript-eslint plugin is registered only so existing
    // `eslint-disable @typescript-eslint/...` comments resolve.
    plugins: { "react-hooks": reactHooks, "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
