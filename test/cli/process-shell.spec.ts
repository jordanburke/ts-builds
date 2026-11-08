import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { runCommand } from "../../src/cli/process"

// Node emits a deprecation once per process, so this file listens from the
// start, before anything in it calls runCommand.
const warnings: Error[] = []
const onWarning = (warning: Error): void => {
  warnings.push(warning)
}
process.on("warning", onWarning)

const nodeMajor = Number(process.versions.node.split(".")[0])
const warningCodes = (): (string | undefined)[] => warnings.map((w) => (w as Error & { code?: string }).code)
/** Deprecation warnings are emitted after the call that triggers them */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

afterAll(() => {
  process.off("warning", onWarning)
})

describe("runCommand shell use", () => {
  // DEP0190 exists from Node 24; on older Node there is nothing to observe
  it.skipIf(nodeMajor < 24)("does not trigger DEP0190 (args passed to a child process with shell: true)", async () => {
    const code = await runCommand("node", ["-v"])
    expect(code).toBe(0)
    await nextTick()
    expect(warningCodes()).not.toContain("DEP0190")

    // Positive control: the deprecated form must be caught here, or the check above proves
    // nothing (e.g. under --no-deprecation, or if this process already emitted DEP0190).
    await new Promise((resolve) => spawn("node", ["-v"], { shell: true, stdio: "ignore" }).on("close", resolve))
    await nextTick()
    expect(warningCodes()).toContain("DEP0190")
  })

  it("keeps an argument the caller quoted for the shell as one argument", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds proc "))
    try {
      const outFile = join(dir, "argv.json")
      const script = join(dir, "argv.cjs")
      writeFileSync(
        script,
        `require("fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)))`,
      )
      const code = await runCommand("node", [JSON.stringify(script), JSON.stringify("two words"), "plain"])
      expect(code).toBe(0)
      expect(JSON.parse(readFileSync(outFile, "utf-8"))).toEqual(["two words", "plain"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns the child's exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds-proc-"))
    try {
      const script = join(dir, "exit.cjs")
      writeFileSync(script, "process.exit(3)")
      expect(await runCommand("node", [script])).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
