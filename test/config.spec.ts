import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { cwdEscapesPackageRoot, deriveCiChain } from "../src/cli/config"

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

describe("deriveCiChain", () => {
  it("swaps each step that writes for its check twin and keeps the rest in order", () => {
    expect(deriveCiChain(["format", "lint", "typecheck", "test", "build"], {})).toEqual([
      "format:check",
      "lint:check",
      "typecheck",
      "test",
      "build",
    ])
  })

  it("leaves steps that are already checks alone", () => {
    expect(deriveCiChain(["format:check", "lint:check", "build"], {})).toEqual(["format:check", "lint:check", "build"])
  })

  it("derives a nested chain inline, so its fixers are swapped too", () => {
    const chains = { "validate:core": ["format", "lint", "test"] }
    expect(deriveCiChain(["validate:core", "docs:check"], chains)).toEqual([
      "format:check",
      "lint:check",
      "test",
      "docs:check",
    ])
  })

  it("leaves a chain that is already being expanded as a reference, so runChain reports the cycle", () => {
    const chains = { a: ["lint", "b"], b: ["a"] }
    expect(deriveCiChain(["a"], chains)).toEqual(["lint:check", "a"])
  })
})

describe("ci (end-to-end)", () => {
  // Each built-in step is replaced by an echo, so the output names exactly which steps ran.
  const markers = {
    format: "echo RAN-FORMAT-WRITE",
    "format:check": "echo RAN-FORMAT-CHECK",
    lint: "echo RAN-LINT-FIX",
    "lint:check": "echo RAN-LINT-CHECK",
    typecheck: "echo RAN-TYPECHECK",
    test: "echo RAN-TEST",
  }

  it("runs validate's chain with format and lint as checks, and never runs the steps that write", () => {
    withConfig({ commands: markers, chains: { validate: ["format", "lint", "typecheck", "test"] } }, (dir) => {
      const { status, out } = runCli(["ci"], dir)
      expect(status).toBe(0)
      expect(out).toMatch(/RAN-FORMAT-CHECK[\s\S]*RAN-LINT-CHECK[\s\S]*RAN-TYPECHECK[\s\S]*RAN-TEST/)
      expect(out).not.toMatch(/RAN-FORMAT-WRITE/)
      expect(out).not.toMatch(/RAN-LINT-FIX/)
    })
  })

  it("follows the legacy validateChain key", () => {
    withConfig({ commands: markers, validateChain: ["lint", "test"] }, (dir) => {
      const { status, out } = runCli(["ci"], dir)
      expect(status).toBe(0)
      expect(out).toMatch(/RAN-LINT-CHECK[\s\S]*RAN-TEST/)
      expect(out).not.toMatch(/RAN-LINT-FIX|RAN-TYPECHECK/)
    })
  })

  it("runs your own chains.ci instead of the derived one", () => {
    withConfig({ commands: markers, chains: { validate: ["format", "lint", "test"], ci: ["typecheck"] } }, (dir) => {
      const { status, out } = runCli(["ci"], dir)
      expect(status).toBe(0)
      expect(out).toMatch(/RAN-TYPECHECK/)
      expect(out).not.toMatch(/RAN-FORMAT|RAN-LINT|RAN-TEST/)
    })
  })

  it("runs an existing commands.ci instead of deriving a chain over it", () => {
    withConfig({ commands: { ...markers, ci: "echo RAN-MY-OWN-CI" }, chains: { validate: ["lint"] } }, (dir) => {
      const { status, out } = runCli(["ci"], dir)
      expect(status).toBe(0)
      expect(out).toMatch(/RAN-MY-OWN-CI/)
      expect(out).not.toMatch(/RAN-LINT/)
    })
  })

  it("refuses to check a replaced format with ts-builds' own check, and names the fix", () => {
    withConfig(
      {
        commands: { format: "echo RAN-OTHER-FORMATTER", test: "echo RAN-TEST" },
        chains: { validate: ["format", "test"] },
      },
      (dir) => {
        const { status, out } = runCli(["ci"], dir)
        expect(status).toBe(1)
        expect(out).toMatch(/replaces "format" but not "format:check"/)
        expect(out).toMatch(/chains\.ci/)
        expect(out).not.toMatch(/RAN-TEST|RAN-OTHER-FORMATTER/)
      },
    )
  })

  it("accepts a replaced lint when its lint:check is replaced too", () => {
    withConfig({ commands: markers, chains: { validate: ["lint", "test"] } }, (dir) => {
      const { status, out } = runCli(["ci"], dir)
      expect(status).toBe(0)
      expect(out).toMatch(/RAN-LINT-CHECK[\s\S]*RAN-TEST/)
    })
  })

  it("derives a nested chain end to end", () => {
    withConfig(
      { commands: markers, chains: { validate: ["validate:core"], "validate:core": ["format", "typecheck"] } },
      (dir) => {
        const { status, out } = runCli(["ci"], dir)
        expect(status).toBe(0)
        expect(out).toMatch(/RAN-FORMAT-CHECK[\s\S]*RAN-TYPECHECK/)
        expect(out).not.toMatch(/RAN-FORMAT-WRITE/)
      },
    )
  })

  it("fails when a step fails, like validate", () => {
    withConfig({ commands: { ...markers, "lint:check": "exit 3" }, chains: { validate: ["lint", "test"] } }, (dir) => {
      const { status, out } = runCli(["ci"], dir)
      expect(status).not.toBe(0)
      expect(out).not.toMatch(/RAN-TEST/)
    })
  })
})
