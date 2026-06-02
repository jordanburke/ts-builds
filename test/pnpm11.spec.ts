import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { detectPnpm11Issues, migratePnpm11 } from "../src/cli/pnpm11"

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

describe("migratePnpm11", () => {
  it("migrates .npmrc hoist patterns to pnpm-workspace.yaml and removes the emptied .npmrc", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, ".npmrc"),
        "# Hoist CLI tool binaries from peer dependencies\npublic-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=typescript\n",
      )
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const report = migratePnpm11(dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("publicHoistPattern:")
      expect(ws).toContain(`  - "*eslint*"`)
      expect(ws).toContain(`  - "typescript"`)
      expect(existsSync(join(dir, ".npmrc"))).toBe(false)
      expect(report.actions.some((a) => a.kind === "migrated")).toBe(true)
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves non-hoist .npmrc lines", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "registry=https://example.com/\npublic-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      migratePnpm11(dir)
      const npmrc = readFileSync(join(dir, ".npmrc"), "utf-8")
      expect(npmrc).toContain("registry=https://example.com/")
      expect(npmrc).not.toContain("public-hoist-pattern")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("migrates known pnpm field keys and prunes the field", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          pnpm: { overrides: { foo: "1.0.0" }, peerDependencyRules: { allowedVersions: { eslint: "10" } } },
        }),
      )
      const report = migratePnpm11(dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("overrides:")
      expect(ws).toContain(`  "foo": "1.0.0"`)
      expect(ws).toContain("peerDependencyRules:")
      expect(ws).toContain("  allowedVersions:")
      expect(ws).toContain(`    "eslint": "10"`)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toBeUndefined()
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports exotic pnpm keys as manual and keeps them in package.json", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", pnpm: { overrides: { foo: "1" }, packageExtensions: { bar: {} } } }),
      )
      const report = migratePnpm11(dir)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toEqual({ packageExtensions: { bar: {} } })
      expect(report.actions.some((a) => a.kind === "manual" && a.message.includes("packageExtensions"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips when a target key already exists in pnpm-workspace.yaml and leaves .npmrc intact", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), `publicHoistPattern:\n  - "existing"\n`)
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const report = migratePnpm11(dir)
      expect(existsSync(join(dir, ".npmrc"))).toBe(true)
      expect(report.actions.some((a) => a.kind === "skipped")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent — a second run with nothing to migrate makes no changes", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      migratePnpm11(dir)
      const wsAfterFirst = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      const report2 = migratePnpm11(dir)
      const wsAfterSecond = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(wsAfterSecond).toBe(wsAfterFirst)
      expect(report2.actions.length).toBe(0)
      expect(report2.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not touch .npmrc when the pnpm-workspace.yaml write fails", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      // Force the ws write to fail by making the path a directory (EISDIR).
      mkdirSync(join(dir, "pnpm-workspace.yaml"))
      const report = migratePnpm11(dir)
      expect(report.errors).toBeGreaterThan(0)
      // .npmrc must be preserved — no data loss.
      expect(readFileSync(join(dir, ".npmrc"), "utf-8")).toContain("public-hoist-pattern[]=*eslint*")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
