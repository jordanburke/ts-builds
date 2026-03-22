// ESLint FP config: Base + strict TypeScript rules from eslint-config-functype
import js from "@eslint/js"
import functypeConfig from "eslint-config-functype"
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
