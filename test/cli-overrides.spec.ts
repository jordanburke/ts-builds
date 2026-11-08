import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadConfig } from "../src/cli/config"
import { BUILTIN_STEP_NAMES, getBuiltinCommands } from "../src/cli/runner"

const cliPath = resolve(__dirname, "../dist/cli.js")

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

/** A temp project whose ts-builds.config.json has these `commands` (and any other config keys) */
function project(commands: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-builds-override-"))
  dirs.push(dir)
  writeFileSync(join(dir, "ts-builds.config.json"), JSON.stringify({ srcDir: "./src", commands, ...extra }))
  return dir
}

/** Leave a lint report behind, as an earlier built-in lint run would */
function staleLintReport(dir: string): string {
  mkdirSync(join(dir, ".ts-builds"))
  const report = join(dir, ".ts-builds", "lint-report.json")
  writeFileSync(report, JSON.stringify({ version: 1, errorCount: 7 }))
  return report
}

function cli(dir: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync("node", [cliPath, ...args], { cwd: dir, encoding: "utf-8" })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe("a commands entry named after a built-in", () => {
  it("replaces the built-in when the command is run directly, as it does in a chain", () => {
    const dir = project({ "lint:check": "echo OVERRIDE lint:check", build: "echo OVERRIDE build" })
    expect(cli(dir, "lint:check")).toMatchObject({ status: 0, output: expect.stringContaining("OVERRIDE lint:check") })
    expect(cli(dir, "build")).toMatchObject({ status: 0, output: expect.stringContaining("OVERRIDE build") })
  })

  it("applies to the sub-command spelling too: `lint check` is `lint:check`", () => {
    const dir = project({ "lint:check": "echo OVERRIDE lint:check", "test:watch": "echo OVERRIDE test:watch" })
    expect(cli(dir, "lint", "check").output).toContain("OVERRIDE lint:check")
    expect(cli(dir, "test", "watch").output).toContain("OVERRIDE test:watch")
  })

  it("returns the override's exit code", () => {
    const dir = project({ typecheck: "exit 3" })
    expect(cli(dir, "typecheck").status).toBe(3)
  })

  it("leaves other built-ins alone", () => {
    // Only lint:check is overridden; `lint` still runs the built-in, which stops on the missing srcDir
    const dir = project({ "lint:check": "echo OVERRIDE lint:check" })
    const { status, output } = cli(dir, "lint")
    expect(output).not.toContain("OVERRIDE")
    expect(output).toContain("No files matching")
    expect(status).toBe(2)
  })

  it("does not apply to commands that are not chain steps", () => {
    const dir = project({ help: "echo OVERRIDE help" })
    const { status, output } = cli(dir, "help")
    expect(status).toBe(0)
    expect(output).not.toContain("OVERRIDE")
    expect(output).toContain("ts-builds")
  })
})

describe("a chain named after a built-in", () => {
  it("runs the chain when the command is run directly, as runStep does inside a chain", () => {
    const dir = project({ say: "echo CHAIN build" }, { chains: { build: ["say"] } })
    expect(cli(dir, "build")).toMatchObject({ status: 0, output: expect.stringContaining("CHAIN build") })
  })
})

describe("the lint report under a lint override", () => {
  it("is removed when an override replaces lint run directly, so lint:summary can't read old counts", () => {
    const dir = project({ "lint:check": "echo OVERRIDE lint:check" })
    const report = staleLintReport(dir)
    expect(cli(dir, "lint:check").status).toBe(0)
    expect(existsSync(report)).toBe(false)
  })

  it("is removed when an override replaces lint inside a chain", () => {
    const dir = project({ lint: "echo OVERRIDE lint" }, { validateChain: ["lint"] })
    const report = staleLintReport(dir)
    expect(cli(dir, "validate").status).toBe(0)
    expect(existsSync(report)).toBe(false)
  })

  it("is kept when a non-lint step is overridden", () => {
    const dir = project({ build: "echo OVERRIDE build" })
    const report = staleLintReport(dir)
    expect(cli(dir, "build").status).toBe(0)
    expect(existsSync(report)).toBe(true)
  })
})

describe("BUILTIN_STEP_NAMES", () => {
  it("lists exactly the built-in chain steps", () => {
    expect([...BUILTIN_STEP_NAMES].sort()).toEqual(Object.keys(getBuiltinCommands(loadConfig())).sort())
  })
})
