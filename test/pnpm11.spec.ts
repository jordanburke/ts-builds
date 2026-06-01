import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { detectPnpm11Issues } from "../src/cli/pnpm11"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-pnpm11-"))
}

describe("detectPnpm11Issues", () => {
  it("warns about public-hoist-pattern lines in .npmrc with a count", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=typescript\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("2 hoist pattern(s) in .npmrc")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about a package.json pnpm field", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { a: "1" } } }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("package.json 'pnpm' field")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about both surfaces when both are present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { a: "1" } } }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.severity === "warning")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports ready when neither surface is present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("info")
      expect(results[0].message).toBe("pnpm 11 ready")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
