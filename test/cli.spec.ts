import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const cliPath = join(__dirname, "..", "dist", "cli.js")

function runCli(args: string[] = [], cwd: string = process.cwd()): string {
  return execFileSync("node", [cliPath, ...args], { cwd, encoding: "utf-8" })
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-cli-"))
}

describe("CLI surface", () => {
  it("shows help with the help command", () => {
    const output = runCli(["help"])
    expect(output).toContain("ts-builds")
    expect(output).toContain("USAGE:")
    expect(output).toContain("COMMANDS:")
    expect(output).toContain("init")
    expect(output).toContain("info")
    expect(output).toContain("cleanup")
  })

  it("shows help with --help flag", () => {
    const output = runCli(["--help"])
    expect(output).toContain("USAGE:")
  })

  it("shows bundled packages with info command", () => {
    const output = runCli(["info"])
    expect(output).toContain("You DON'T need to install:")
    expect(output).toContain("eslint")
    expect(output).toContain("prettier")
    expect(output).toContain("typescript")
    expect(output).toContain("vitest")
    expect(output).toContain("tsdown")
  })

  it("runs init by default with no args", () => {
    const dir = makeTempDir()
    try {
      const output = runCli([], dir)
      expect(output).toContain("Initializing ts-builds")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("dist/cli.js bundle invariants", () => {
  // After the shell-out removal, the bundle must not contain rimraf or
  // cross-env as literals. If a regression re-adds shell-out invocations,
  // these strings reappear and this test catches them before publish.
  const bundle = readFileSync(cliPath, "utf-8")

  it("does not invoke rimraf as a shell command", () => {
    expect(bundle).not.toMatch(/["']rimraf["']/)
    expect(bundle).not.toMatch(/rimraf\s+dist/)
  })

  it("does not invoke cross-env as a shell command", () => {
    expect(bundle).not.toMatch(/["']cross-env["']/)
    expect(bundle).not.toMatch(/cross-env\s+NODE_ENV/)
  })

  it("imports rm from node:fs/promises (proves Node-API clean is wired)", () => {
    expect(bundle).toMatch(/from\s*["']node:fs\/promises["']/)
  })
})

describe("init .npmrc generation", () => {
  it("produces exactly the expected hoist patterns (no rimraf, no cross-env)", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      const npmrc = readFileSync(join(dir, ".npmrc"), "utf-8")
      const patterns = npmrc
        .split("\n")
        .filter((l) => l.startsWith("public-hoist-pattern[]="))
        .sort()
      expect(patterns).toEqual([
        "public-hoist-pattern[]=*eslint*",
        "public-hoist-pattern[]=*prettier*",
        "public-hoist-pattern[]=*vitest*",
        "public-hoist-pattern[]=typescript",
      ])
      expect(npmrc).not.toContain("rimraf")
      expect(npmrc).not.toContain("cross-env")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent — running init twice does not duplicate hoist lines", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      const firstRun = readFileSync(join(dir, ".npmrc"), "utf-8")
      runCli([], dir)
      const secondRun = readFileSync(join(dir, ".npmrc"), "utf-8")
      // Each hoist line should appear exactly once after either run.
      const patterns = ["*eslint*", "*prettier*", "*vitest*", "typescript"]
      for (const pat of patterns) {
        const needle = `public-hoist-pattern[]=${pat}`
        expect(firstRun.split(needle).length - 1, `first run: ${needle}`).toBe(1)
        expect(secondRun.split(needle).length - 1, `second run: ${needle}`).toBe(1)
      }
      // Content must not have grown unboundedly.
      expect(secondRun.length).toBe(firstRun.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves pre-existing non-hoist lines in .npmrc", () => {
    const dir = makeTempDir()
    try {
      const userLine = "registry=https://my-private-registry.example.com/"
      writeFileSync(join(dir, ".npmrc"), userLine + "\n")
      runCli([], dir)
      const npmrc = readFileSync(join(dir, ".npmrc"), "utf-8")
      expect(npmrc).toContain(userLine)
      expect(npmrc).toContain("public-hoist-pattern[]=*eslint*")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
