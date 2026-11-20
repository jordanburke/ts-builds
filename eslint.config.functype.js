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
      // functype 2.0 moves value methods onto shared prototypes, so a detached call such as
      // `xs.map(opt.orElse)` or `const { map } = opt` will throw. This warns about those calls now.
      // The rule only checks members declared with method syntax. On functype 1.x that is Option,
      // but not most of Try, Either and List, which use arrow-typed properties; 2.0 switches them.
      // `ignoreStatic` skips class statics, which are usually called without `this`.
      "@typescript-eslint/unbound-method": ["warn", { ignoreStatic: true }],
    },
  },
  // Last, so they win over the rules above, and a consumer's own blocks after them win over them.
  functypeConfig.configs.testOverrides,
  functypePlugin.configs.tests,
  // Tests pass methods to `expect(obj.method)` without calling them, and a detached call that
  // throws in 2.0 fails the test run anyway, so unbound-method is off for test files.
  {
    name: "ts-builds/functype-tests",
    files: functypeConfig.configs.testOverrides.files,
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
]
