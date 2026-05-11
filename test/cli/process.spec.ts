import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { runCommand } from "../../src/cli/process"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-proc-"))
}

/**
 * Run a tiny Node script via `runCommand` that captures `process.env` and
 * `process.cwd()` to a JSON file. Black-box test of the env/cwd contract —
 * we don't peek at spawn's options; we observe what the child actually saw.
 *
 * We write the script to a temp file rather than passing via `node -e` because
 * `runCommand` uses `shell: true`, which would mangle the inline script's
 * quoting on its way through the shell.
 */
async function captureChildState(
  envOverride: NodeJS.ProcessEnv | undefined,
  cwdOption: string | undefined,
): Promise<{ env: NodeJS.ProcessEnv; cwd: string }> {
  const dir = makeTempDir()
  try {
    const outFile = join(dir, "state.json")
    const scriptFile = join(dir, "capture.cjs")
    const script = `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ env: process.env, cwd: process.cwd() }));`
    writeFileSync(scriptFile, script)
    const code = await runCommand("node", [scriptFile], {
      env: envOverride,
      cwd: cwdOption,
    })
    expect(code).toBe(0)
    return JSON.parse(readFileSync(outFile, "utf-8"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("runCommand env handling", () => {
  it("passes options.env keys to the child process", async () => {
    const { env } = await captureChildState({ TS_BUILDS_TEST_MARKER: "child-only" }, undefined)
    expect(env.TS_BUILDS_TEST_MARKER).toBe("child-only")
  })

  it("preserves parent env keys when options.env is provided", async () => {
    const { env } = await captureChildState({ TS_BUILDS_TEST_MARKER: "x" }, undefined)
    // PATH is set by the test runner; if env-merge regressed to replace-not-merge,
    // the child would lose PATH entirely (or have an empty one).
    expect(env.PATH).toBeDefined()
    expect((env.PATH ?? "").length).toBeGreaterThan(0)
  })

  it("does NOT mutate parent process.env when options.env is provided", async () => {
    const key = "TS_BUILDS_NO_MUTATION_CANARY"
    delete process.env[key]
    expect(process.env[key]).toBeUndefined()
    await captureChildState({ [key]: "child-only" }, undefined)
    // The parent must still not see this key — the child saw it via spawn's
    // env option, not via process.env mutation.
    expect(process.env[key]).toBeUndefined()
  })

  it("forwards parent env to child when no options.env is given", async () => {
    process.env.TS_BUILDS_PARENT_ONLY = "from-parent"
    try {
      const { env } = await captureChildState(undefined, undefined)
      expect(env.TS_BUILDS_PARENT_ONLY).toBe("from-parent")
    } finally {
      delete process.env.TS_BUILDS_PARENT_ONLY
    }
  })

  it("lets options.env override an existing parent env value for the child only", async () => {
    process.env.TS_BUILDS_OVERRIDE_CANARY = "parent"
    try {
      const { env } = await captureChildState({ TS_BUILDS_OVERRIDE_CANARY: "child" }, undefined)
      expect(env.TS_BUILDS_OVERRIDE_CANARY).toBe("child")
      // Parent's view unchanged after the call.
      expect(process.env.TS_BUILDS_OVERRIDE_CANARY).toBe("parent")
    } finally {
      delete process.env.TS_BUILDS_OVERRIDE_CANARY
    }
  })
})

describe("runCommand cwd handling", () => {
  it("runs in targetDir (process.cwd()) when no cwd option is given", async () => {
    const { cwd } = await captureChildState(undefined, undefined)
    expect(cwd).toBe(process.cwd())
  })

  it("joins options.cwd with targetDir for the child", async () => {
    // "." resolves to targetDir; "./src" resolves to <targetDir>/src.
    const { cwd } = await captureChildState(undefined, "./src")
    expect(cwd).toBe(join(process.cwd(), "src"))
  })
})
