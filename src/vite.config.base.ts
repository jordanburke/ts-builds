import { resolve } from "node:path"

import type { UserConfig } from "vite"

/** Base Vite config for SPAs */
export const vite: UserConfig = {
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2020",
    minify: process.env.NODE_ENV === "production",
  },
  resolve: {
    alias: { "@": resolve(process.cwd(), "src") },
  },
}

export default vite
