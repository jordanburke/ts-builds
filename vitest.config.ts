import { configDefaults, defineConfig } from "vitest/config"

// test/fixtures holds sample projects. Their own test files are data the specs lint,
// not tests for this repo to run.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
    // Installs test/fixtures/architecture once, before any spec copies or lints it.
    globalSetup: ["test/setup-fixtures.ts"],
  },
})
