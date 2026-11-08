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

afterAll(() => {
  process.off("warning", onWarning)
})

describe("runCommand shell use", () => {
  it("does not trigger DEP0190 (args passed to a child process with shell: true)", async () => {
    const code = await runCommand("node", ["-v"])
    expect(code).toBe(0)
    // Deprecation warnings are emitted on the next tick
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(warnings.map((w) => (w as Error & { code?: string }).code)).not.toContain("DEP0190")
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
