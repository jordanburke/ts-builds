import { defineConfig } from "tsup"

export default defineConfig([
  // Config files (no shebang)
  {
    entry: ["src/tsup.config.base.ts", "src/vitest.config.base.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    outDir: "dist",
    splitting: false,
    sourcemap: false,
    minify: false,
    bundle: false,
    skipNodeModulesBundle: true,
    target: "es2022",
    outExtension: () => ({ js: ".js" }),
  },
  // CLI (with shebang)
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist",
    splitting: false,
    sourcemap: false,
    minify: false,
    bundle: false,
    skipNodeModulesBundle: true,
    target: "es2022",
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
])
