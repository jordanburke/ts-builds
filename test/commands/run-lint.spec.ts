import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { LintReport } from "../../src/cli/lint-report"

/**
 * These exercise `runLint`'s bundled Node-API path end to end — the highest-risk code,
 * unreachable by a plain unit test because `targetDir` is captured at module load. We
 * spawn the built CLI with `cwd` set to a throwaway package so ESLint lints the fixture
 * and writes the sidecar there. Skipped (not failed) when `dist/cli.js` is absent, e.g.
 * a bare `pnpm test` before `pnpm build`; CI runs `validate:bootstrap` (build → test).
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
const cliPath = join(repoRoot, "dist", "cli.js")
const itIfBuilt = it.skipIf(!existsSync(cliPath))

function makeFixture(config: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-builds-run-lint-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@fixture/pkg", type: "module" }))
  writeFileSync(join(dir, "eslint.config.js"), config)
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, contents)
  }
  return dir
}

function runCli(cwd: string, ...args: string[]): { status: number; stdout: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf-8" })
  return { status: res.status ?? -1, stdout: res.stdout ?? "" }
}

function readReport(dir: string): LintReport {
  return JSON.parse(readFileSync(join(dir, ".ts-builds", "lint-report.json"), "utf-8")) as LintReport
}

describe("runLint (bundled Node API, via built CLI)", () => {
  itIfBuilt("errors → exit 1, stylish output printed, sidecar errorCount>0", () => {
    const dir = makeFixture('export default [{ rules: { "no-unused-vars": "error" } }]', {
      "src/a.js": "const unused = 1\nexport default 2\n",
    })
    try {
      const { status, stdout } = runCli(dir, "lint:check")
      expect(status).toBe(1)
      expect(stdout).toContain("no-unused-vars") // proves writeAll flushed the report
      const report = readReport(dir)
      expect(report.errorCount).toBeGreaterThan(0)
      expect(report.fix).toBe(false)
      expect(report.fatal).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itIfBuilt("no matching files (thrown) → exit 2, fatal sidecar", () => {
    const dir = makeFixture("export default []", {}) // no src/
    try {
      const { status } = runCli(dir, "lint:check")
      expect(status).toBe(2)
      expect(readReport(dir).fatal).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itIfBuilt("--fix writes fixes to disk, sidecar fix:true errorCount:0", () => {
    const dir = makeFixture('export default [{ rules: { semi: ["error", "never"] } }]', {
      "src/a.js": "export const x = 1;;\n",
    })
    try {
      const { status } = runCli(dir, "lint") // fix mode
      expect(status).toBe(0)
      expect(readFileSync(join(dir, "src", "a.js"), "utf-8")).not.toContain(";")
      const report = readReport(dir)
      expect(report.fix).toBe(true)
      expect(report.errorCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
