import { createBoundaries } from "ts-builds/eslint-boundaries"
import tseslint from "typescript-eslint"

import architecture from "./architecture.mjs"

export default [
  {
    files: ["**/*.{ts,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...createBoundaries(architecture).configs,
]
