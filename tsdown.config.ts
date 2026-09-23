import { defineConfig } from "tsdown"

export default defineConfig([
  // Config files (no shebang). Consumers import these from their own
  // tsdown/vite/vitest config files, so they ship declarations: without them
  // an IDE type-checking `import { tsdown } from "ts-builds/tsdown"` reports
  // TS7016 / TS2307. test/package-exports.spec.ts checks they exist.
  {
    entry: ["src/tsdown.config.base.ts", "src/vitest.config.base.ts", "src/vite.config.base.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    outDir: "dist",
    sourcemap: false,
    minify: false,
    target: "es2022",
    tsconfig: "tsconfig.json",
    outputOptions: {
      entryFileNames: "[name].js",
    },
  },
  // CLI (with shebang)
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist",
    sourcemap: false,
    minify: false,
    target: "es2022",
    tsconfig: "tsconfig.json",
    outputOptions: {
      entryFileNames: "[name].js",
    },
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
])
