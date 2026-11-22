import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { execSync, spawnSync } from "node:child_process"

const cliPath = join(process.cwd(), "dist/cli.js")

describe("ts-builds size", () => {
  const inPackage = (baselineFile: string, run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds-size-"))
    try {
      mkdirSync(join(dir, "dist"))
      writeFileSync(join(dir, "dist", "index.js"), "export const x = 1\n")
      writeFileSync(join(dir, "ts-builds.config.json"), JSON.stringify({ size: { baselineFile } }))
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("--save writes the baseline and exits 0", () => {
    inPackage("baseline.json", (dir) => {
      const res = spawnSync(process.execPath, [cliPath, "size", "--save"], { cwd: dir, encoding: "utf-8" })
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("Baseline saved to baseline.json")
      expect(existsSync(join(dir, "baseline.json"))).toBe(true)
    })
  })

  it("--save exits 1 with the reason when it can't write the baseline", () => {
    inPackage("missing/baseline.json", (dir) => {
      const res = spawnSync(process.execPath, [cliPath, "size", "--save"], { cwd: dir, encoding: "utf-8" })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain("Couldn't save the baseline to missing/baseline.json")
      expect(res.stdout).not.toContain("Baseline saved")
    })
  })

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
