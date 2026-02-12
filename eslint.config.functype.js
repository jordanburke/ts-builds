// ESLint Functype config: Base + FP rules + eslint-plugin-functype rules
// Full functype support: prefer-option, prefer-either, prefer-fold, etc.
import js from "@eslint/js"
import functypeConfig from "eslint-config-functype"
import functional from "eslint-plugin-functional"
import functypePlugin from "eslint-plugin-functype"
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
      functype: functypePlugin,
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
      "functype/prefer-option": "warn",
      "functype/prefer-either": "warn",
      "functype/prefer-fold": "warn",
      "functype/prefer-map": "warn",
      "functype/prefer-flatmap": "warn",
      "functype/no-imperative-loops": "warn",
      "functype/prefer-do-notation": "warn",
    },
  },
]
