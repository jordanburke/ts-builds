import type { UserConfig } from "tsdown"

const env = process.env.NODE_ENV

export const tsdown: UserConfig = {
  sourcemap: true,
  clean: true,
  dts: true,
  format: ["esm"],
  minify: env === "production",
  target: "es2020",
  outDir: env === "production" ? "dist" : "lib",
  entry: ["src/index.ts", "src/**/*.ts"],
}
