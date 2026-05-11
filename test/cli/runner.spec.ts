import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { ResolvedConfig } from "../../src/cli/config"
import { runChain } from "../../src/cli/runner"

function baseConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    srcDir: "./src",
    testDir: "./test",
    buildMode: "tsdown",
    lint: { useProjectEslint: false },
    size: {},
    changelog: {},
    commands: {},
    chains: {},
    ...overrides,
  }
}

/** Shell snippet that writes a marker file at `path`. Portable across sh/bash/zsh. */
function touchCommand(path: string): string {
  return `: > ${JSON.stringify(path)}`
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ts-builds-runner-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("runChain step execution", () => {
  it("runs user-defined commands in order and returns 0 on success", async () => {
    const marker1 = join(tempDir, "step1.marker")
    const marker2 = join(tempDir, "step2.marker")
    const config = baseConfig({
      commands: {
        step1: { run: touchCommand(marker1) },
        step2: { run: touchCommand(marker2) },
      },
      chains: { test: ["step1", "step2"] },
    })
    const code = await runChain("test", config)
    expect(code).toBe(0)
    expect(existsSync(marker1)).toBe(true)
    expect(existsSync(marker2)).toBe(true)
  })

  it("halts the chain on first failure — subsequent steps must NOT execute", async () => {
    const skippedMarker = join(tempDir, "should-not-run.marker")
    const config = baseConfig({
      commands: {
        fail: { run: "exit 7" },
        skipped: { run: touchCommand(skippedMarker) },
      },
      chains: { test: ["fail", "skipped"] },
    })
    const code = await runChain("test", config)
    expect(code).toBe(7)
    expect(existsSync(skippedMarker)).toBe(false)
  })

  it("propagates exact non-zero exit codes from a failing step", async () => {
    const config = baseConfig({
      commands: { bad: { run: "exit 42" } },
      chains: { test: ["bad"] },
    })
    const code = await runChain("test", config)
    expect(code).toBe(42)
  })
})

describe("runChain builtin override", () => {
  it("a user-defined command overrides the same-named builtin", async () => {
    // The `build` builtin would invoke runBuild → tsdown, which would fail
    // in this temp config (no tsdown config, no source). If user override is
    // honored, only our marker side-effect runs and the chain succeeds.
    const marker = join(tempDir, "user-build.marker")
    const config = baseConfig({
      commands: { build: { run: touchCommand(marker) } },
      chains: { test: ["build"] },
    })
    const code = await runChain("test", config)
    expect(code).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })
})

describe("runChain references", () => {
  it("follows nested chain references", async () => {
    const outer = join(tempDir, "outer.marker")
    const inner = join(tempDir, "inner.marker")
    const config = baseConfig({
      commands: {
        "inner-cmd": { run: touchCommand(inner) },
        "outer-cmd": { run: touchCommand(outer) },
      },
      chains: {
        outer: ["outer-cmd", "inner-chain"],
        "inner-chain": ["inner-cmd"],
      },
    })
    const code = await runChain("outer", config)
    expect(code).toBe(0)
    expect(existsSync(outer)).toBe(true)
    expect(existsSync(inner)).toBe(true)
  })

  it("detects circular chain references and returns non-zero", async () => {
    const config = baseConfig({
      commands: {},
      chains: {
        a: ["b"],
        b: ["a"],
      },
    })
    const code = await runChain("a", config)
    expect(code).toBe(1)
  })

  it("returns 1 when the named chain does not exist", async () => {
    const config = baseConfig({ chains: {}, commands: {} })
    const code = await runChain("nonexistent", config)
    expect(code).toBe(1)
  })

  it("returns 1 when a step references an unknown command/chain", async () => {
    const config = baseConfig({
      commands: {},
      chains: { test: ["ghost-step"] },
    })
    const code = await runChain("test", config)
    expect(code).toBe(1)
  })
})
