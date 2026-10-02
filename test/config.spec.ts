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

function runCli(args: string[], cwd: string): { status: number; out: string } {
  try {
    const out = execFileSync("node", [cliPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { status: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }
  }
}

function withConfig(config: unknown, fn: (dir: string) => void): void {
  const dir = makeTempDir()
  try {
    writeFileSync(join(dir, "ts-builds.config.json"), JSON.stringify(config))
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

describe("validate:* cwd escaping the package root (end-to-end, #72)", () => {
  // cwd ".." exists, so without the check these commands would run and pass.
  it("fails a chain step whose validate:* cwd escapes, without running it", () => {
    withConfig(
      {
        commands: { "validate:sibling": { run: "echo RAN-SIBLING", cwd: ".." } },
        chains: { validate: ["validate:sibling"] },
      },
      (dir) => {
        const { status, out } = runCli(["validate"], dir)
        expect(status).toBe(1)
        expect(out).toMatch(/validate:sibling/)
        expect(out).toMatch(/escapes the package root/)
        expect(out).toMatch(/issues\/72/)
        expect(out).not.toMatch(/RAN-SIBLING/)
      },
    )
  })

  it("fails a validate:* command invoked directly when its cwd escapes", () => {
    withConfig({ commands: { "validate:sibling": { run: "echo RAN-SIBLING", cwd: ".." } } }, (dir) => {
      const { status, out } = runCli(["validate:sibling"], dir)
      expect(status).toBe(1)
      expect(out).toMatch(/issues\/72/)
      expect(out).not.toMatch(/RAN-SIBLING/)
    })
  })

  it("runs a validate:* command whose cwd stays inside the package", () => {
    withConfig(
      {
        commands: { "validate:inroot": { run: "echo RAN-INROOT", cwd: "." } },
        chains: { validate: ["validate:inroot"] },
      },
      (dir) => {
        const { status, out } = runCli(["validate"], dir)
        expect(status).toBe(0)
        expect(out).toMatch(/RAN-INROOT/)
      },
    )
  })

  it("runs a non-validate command even when its cwd escapes", () => {
    withConfig(
      {
        commands: { other: { run: "echo RAN-OTHER", cwd: ".." } },
        chains: { validate: ["other"] },
      },
      (dir) => {
        const { status, out } = runCli(["validate"], dir)
        expect(status).toBe(0)
        expect(out).toMatch(/RAN-OTHER/)
      },
    )
  })
})
