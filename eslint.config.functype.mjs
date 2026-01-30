// ESLint Functype config: Base + FP rules + eslint-plugin-functype rules
// Full functype support: prefer-option, prefer-either, prefer-fold, etc.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { FlatCompat } from "@eslint/eslintrc"
import js from "@eslint/js"
import typescriptEslint from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import functypeConfig from "eslint-config-functype"
import functional from "eslint-plugin-functional"
import functypePlugin from "eslint-plugin-functype"
import prettier from "eslint-plugin-prettier"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import globals from "globals"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

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
  ...compat.extends("eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:prettier/recommended"),
  {
    plugins: {
      "@typescript-eslint": typescriptEslint,
      "simple-import-sort": simpleImportSort,
      functional,
      functype: functypePlugin,
      prettier,
    },

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.amd,
        ...globals.node,
      },

      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: "module",

      parserOptions: {
        projectService: true,
      },
    },

    settings: {
      "import/resolver": {
        node: {
          paths: ["'src'"],
          extensions: [".js", ".ts"],
        },
      },
    },

    rules: {
      // Include all rules from eslint-config-functype recommended
      ...functypeConfig.configs.recommended.rules,
      // Functype library-specific rules
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
