import { defineConfig } from "tsdown"

export default defineConfig([
  // Config files (no shebang)
  {
    entry: ["src/tsdown.config.base.ts", "src/vitest.config.base.ts", "src/vite.config.base.ts"],
    format: ["esm"],
    dts: false,
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
