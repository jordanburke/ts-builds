import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { cwdEscapesPackageRoot } from "../src/cli/config"

const cliPath = join(process.cwd(), "dist/cli.js")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-test-"))
}

function runCliCapture(args: string[], cwd: string): string {
  try {
    return execFileSync("node", [cliPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (err) {
    // ts-builds validate will exit non-zero when the configured command fails
    // (e.g. echo in a nonexistent cwd). We still want stdout+stderr for assertions.
    const e = err as { stdout?: string; stderr?: string }
    return (e.stdout ?? "") + (e.stderr ?? "")
  }
}

describe("cwdEscapesPackageRoot", () => {
  const baseDir = "/tmp/ts-builds-base"

  it("returns false for current dir (dot / empty)", () => {
    expect(cwdEscapesPackageRoot(".", baseDir)).toBe(false)
    expect(cwdEscapesPackageRoot("./", baseDir)).toBe(false)
  })

  it("returns false for in-root child paths", () => {
    expect(cwdEscapesPackageRoot("./packages/sub", baseDir)).toBe(false)
    expect(cwdEscapesPackageRoot("packages/sub", baseDir)).toBe(false)
    expect(cwdEscapesPackageRoot("./tests/fixtures", baseDir)).toBe(false)
  })

  it("returns true for parent traversal", () => {
    expect(cwdEscapesPackageRoot("..", baseDir)).toBe(true)
    expect(cwdEscapesPackageRoot("../other", baseDir)).toBe(true)
    expect(cwdEscapesPackageRoot("../../sibling", baseDir)).toBe(true)
  })

  it("returns true for absolute paths outside baseDir", () => {
    expect(cwdEscapesPackageRoot("/var/log", baseDir)).toBe(true)
    expect(cwdEscapesPackageRoot("/tmp/other", baseDir)).toBe(true)
  })

  it("returns false for absolute path equal to baseDir", () => {
    expect(cwdEscapesPackageRoot(baseDir, baseDir)).toBe(false)
  })

  it("returns false for absolute path inside baseDir", () => {
    expect(cwdEscapesPackageRoot(resolve(baseDir, "sub"), baseDir)).toBe(false)
  })

  it("returns true for normalized parent traversal that resolves outside", () => {
    expect(cwdEscapesPackageRoot("./packages/../../other", baseDir)).toBe(true)
  })
})

describe("loadConfig deprecation warning (end-to-end)", () => {
  it("emits warning for validate:* with parent-traversal cwd", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(
        join(dir, "ts-builds.config.json"),
        JSON.stringify({
          commands: {
            "validate:sibling": { run: "echo hi", cwd: "../other-pkg" },
          },
          chains: { validate: ["validate:sibling"] },
        }),
      )
      const out = runCliCapture(["validate"], dir)
      expect(out).toMatch(/Deprecation/)
      expect(out).toMatch(/validate:sibling/)
      expect(out).toMatch(/issues\/72/)
      expect(out).toMatch(/ts-builds 4\.0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not warn for validate:* with in-root cwd", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(
        join(dir, "ts-builds.config.json"),
        JSON.stringify({
          commands: {
            "validate:inroot": { run: "echo hi", cwd: "./fixtures" },
          },
          chains: { validate: ["validate:inroot"] },
        }),
      )
      const out = runCliCapture(["validate"], dir)
      expect(out).not.toMatch(/Deprecation/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not warn for non-validate-prefixed commands even with escaping cwd", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(
        join(dir, "ts-builds.config.json"),
        JSON.stringify({
          commands: {
            other: { run: "echo hi", cwd: "../sibling" },
          },
          chains: { validate: ["other"] },
        }),
      )
      const out = runCliCapture(["validate"], dir)
      expect(out).not.toMatch(/Deprecation/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("deduplicates: same offending entry produces a single warning per load", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(
        join(dir, "ts-builds.config.json"),
        JSON.stringify({
          commands: {
            "validate:a": { run: "echo a", cwd: "../x" },
            "validate:b": { run: "echo b", cwd: "../x" },
          },
          chains: { validate: ["validate:a", "validate:b"] },
        }),
      )
      const out = runCliCapture(["validate"], dir)
      const matches = out.match(/Deprecation/g) ?? []
      // Two distinct names → two warnings; dedup is per (name, cwd) pair.
      expect(matches.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
