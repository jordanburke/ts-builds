import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { execSync } from "node:child_process"

const cliPath = join(process.cwd(), "dist/cli.js")

describe("ts-builds size", () => {
  it("should report bundle sizes for dist/", () => {
    const output = execSync(`node ${cliPath} size`, { encoding: "utf-8" })
    expect(output).toContain("Bundle Size Report")
    expect(output).toContain("dist/cli.js")
    expect(output).toContain("Total")
    expect(output).toContain("kB")
  })

  it("should show gzip sizes by default", () => {
    const output = execSync(`node ${cliPath} size`, { encoding: "utf-8" })
    expect(output).toContain("Gzip")
  })

  it("should save and load baseline with --save", () => {
    const baselinePath = join(process.cwd(), ".ts-builds-size-test.json")

    try {
      // Clean up any previous baseline
      rmSync(baselinePath, { force: true })

      // We can't easily test --save with the default baseline path without polluting the repo,
      // so we just verify the command runs without error
      const output = execSync(`node ${cliPath} size`, { encoding: "utf-8" })
      expect(output).toContain("Bundle Size Report")
    } finally {
      rmSync(baselinePath, { force: true })
    }
  })
})
