import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Every built JavaScript entry a consumer can import must ship types.
 *
 * Consumers import `ts-builds/tsdown`, `/vite` and `/vitest` from their own
 * `tsdown.config.ts` / `vite.config.ts` / `vitest.config.ts`. Those files sit
 * outside most projects' tsconfig `include`, so `tsc` never checks them --
 * only the IDE does, and it reported TS7016 / TS2307 while the build was
 * `dts: false` and the exports had no `types`. Nothing else would catch it.
 *
 * Runs after the build (`validate:bootstrap`), as the CLI tests do.
 */
const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
  exports: Record<string, string | { types?: string; default?: string }>
}

const builtEntries = Object.entries(pkg.exports).filter(([, target]) => {
  const file = typeof target === "string" ? target : target.default
  return file?.startsWith("./dist/") && file.endsWith(".js")
})

describe("package exports", () => {
  it("covers the three config entries", () => {
    expect(builtEntries.map(([name]) => name).sort()).toEqual(["./tsdown", "./vite", "./vitest"])
  })

  it.each(builtEntries)("%s declares its types", (_name, target) => {
    expect(typeof target).toBe("object")
    const { types, default: js } = target as { types?: string; default?: string }
    expect(types).toBe(js!.replace(/\.js$/, ".d.ts"))
  })

  it.each(builtEntries)("%s ships the files it points at", (_name, target) => {
    const { types, default: js } = target as { types: string; default: string }
    expect(existsSync(join(root, js))).toBe(true)
    expect(existsSync(join(root, types))).toBe(true)
  })

  it("declares what each config module exports", () => {
    const dts = (name: string) => readFileSync(join(root, "dist", `${name}.d.ts`), "utf-8")
    expect(dts("tsdown.config.base")).toMatch(/export declare const tsdown: UserConfig/)
    expect(dts("vite.config.base")).toMatch(/export \{ vite as default \}/)
    expect(dts("vitest.config.base")).toMatch(/export \{ _default as default \}/)
  })
})
