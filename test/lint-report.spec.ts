import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

import {
  buildLintReport,
  fatalLintReport,
  LINT_REPORT_VERSION,
  lintReportPath,
  readPackageName,
  writeLintReport,
} from "../src/cli/lint-report"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-lint-report-"))
}

/** Minimal ESLint.LintResult — only the fields buildLintReport reads. */
function result(over: Partial<ESLint.LintResult>): ESLint.LintResult {
  return {
    filePath: "/x.ts",
    messages: [],
    suppressedMessages: [],
    errorCount: 0,
    fatalErrorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
    ...over,
  } as ESLint.LintResult
}

describe("buildLintReport", () => {
  it("sums counts across files and lists only files with issues", () => {
    const results = [
      result({ filePath: "/a.ts", errorCount: 2, warningCount: 1, fixableErrorCount: 1 }),
      result({ filePath: "/b.ts", errorCount: 0, warningCount: 3, fixableWarningCount: 2 }),
      result({ filePath: "/clean.ts", errorCount: 0, warningCount: 0 }),
    ]
    const report = buildLintReport(results, false, "pkg")

    expect(report.version).toBe(LINT_REPORT_VERSION)
    expect(report.package).toBe("pkg")
    expect(report.fix).toBe(false)
    expect(report.errorCount).toBe(2)
    expect(report.warningCount).toBe(4)
    expect(report.fixableErrorCount).toBe(1)
    expect(report.fixableWarningCount).toBe(2)
    expect(report.fileCount).toBe(3)
    // clean.ts is excluded from the per-file list
    expect(report.files.map((f) => f.filePath)).toEqual(["/a.ts", "/b.ts"])
    expect(report.fatal).toBeUndefined()
  })

  it("records fix mode", () => {
    expect(buildLintReport([], true, "pkg").fix).toBe(true)
  })
})

describe("fatalLintReport", () => {
  it("marks fatal with zeroed counts", () => {
    const report = fatalLintReport(true, "pkg")
    expect(report.fatal).toBe(true)
    expect(report.errorCount).toBe(0)
    expect(report.fileCount).toBe(0)
    expect(report.package).toBe("pkg")
  })
})

describe("readPackageName", () => {
  it("reads name from package.json", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@scope/thing" }))
      expect(readPackageName(dir)).toBe("@scope/thing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to the directory name when package.json is missing or unnamed", () => {
    const dir = makeTempDir()
    try {
      expect(readPackageName(dir)).toBe(dir.split("/").pop())
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }))
      expect(readPackageName(dir)).toBe(dir.split("/").pop())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("writeLintReport", () => {
  it("writes JSON to <dir>/.ts-builds/lint-report.json with a trailing newline", async () => {
    const dir = makeTempDir()
    try {
      const report = fatalLintReport(false, "pkg")
      await writeLintReport(report, dir)
      const raw = readFileSync(lintReportPath(dir), "utf-8")
      expect(raw.endsWith("\n")).toBe(true)
      expect(JSON.parse(raw)).toEqual(report)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
