// ESLint Functype config: Base + FP rules + eslint-plugin-functype rules
// Full functype support: prefer-option, prefer-either, prefer-fold, etc.
import js from "@eslint/js"
import functypeConfig from "eslint-config-functype"
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
      ...functypePlugin.configs.recommended.rules,
      // functype 2.0 keeps value methods on shared prototypes, so a detached call such as
      // `xs.map(opt.getOrElse)` or `const { map } = opt` throws. An error, like every rule
      // eslint-plugin-functype's preset enables. The rule checks members declared with method syntax,
      // which 2.0 uses for every value type. `ignoreStatic` skips class statics, which are usually
      // called without `this`.
      "@typescript-eslint/unbound-method": ["error", { ignoreStatic: true }],
    },
  },
  // Last, so they win over the rules above, and a consumer's own blocks after them win over them.
  functypeConfig.configs.testOverrides,
  functypePlugin.configs.tests,
  // Tests pass methods to `expect(obj.method)` without calling them, and a detached call that
  // throws fails the test run anyway, so unbound-method is off for test files.
  {
    name: "ts-builds/functype-tests",
    files: functypeConfig.configs.testOverrides.files,
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
]
