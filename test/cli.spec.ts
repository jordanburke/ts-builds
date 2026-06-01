import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
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

describe("init pnpm-workspace.yaml generation", () => {
  it("produces the expected publicHoistPattern list", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("publicHoistPattern:")
      expect(ws).toContain(`  - "*eslint*"`)
      expect(ws).toContain(`  - "*prettier*"`)
      expect(ws).toContain(`  - "*vitest*"`)
      expect(ws).toContain(`  - "typescript"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent — running init twice does not duplicate the block", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      const firstRun = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      runCli([], dir)
      const secondRun = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(secondRun).toBe(firstRun)
      expect(secondRun.split("publicHoistPattern:").length - 1).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves pre-existing pnpm-workspace.yaml content", () => {
    const dir = makeTempDir()
    try {
      const existing = 'packages:\n  - "packages/*"\n'
      writeFileSync(join(dir, "pnpm-workspace.yaml"), existing)
      runCli([], dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain(`packages:`)
      expect(ws).toContain(`  - "packages/*"`)
      expect(ws).toContain("publicHoistPattern:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends valid YAML when the existing file has no trailing newline", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"`)
      runCli([], dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      // The pre-existing key and the appended key must be on separate lines.
      expect(ws).toMatch(/- "packages\/\*"\npublicHoistPattern:/)
      expect(ws).toContain(`  - "*eslint*"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not create a .npmrc", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      expect(existsSync(join(dir, ".npmrc"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
