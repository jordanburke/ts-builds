// ESLint FP config: Base + functional programming rules from eslint-config-functype
// Includes: no-let, immutable-data, prefer-immutable-types, etc.
import js from "@eslint/js"
import functypeConfig from "eslint-config-functype"
import functional from "eslint-plugin-functional"
import prettierRecommended from "eslint-plugin-prettier/recommended"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import globals from "globals"
import tseslint from "typescript-eslint"

export default [
  {
    ignores: [
      "**/.gitignore",
      "**/.eslintignore",
      "**/node_modules",
      "**/.DS_Store",
      "**/dist-ssr",
      "**/*.local",
      "**/tsconfig.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
      functional,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.amd,
        ...globals.node,
      },
      ecmaVersion: 2020,
      sourceType: "module",
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      ...functypeConfig.configs.recommended.rules,
    },
  },
]
