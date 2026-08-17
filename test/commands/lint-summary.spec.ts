import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  aggregateLintReports,
  findLintReports,
  formatLintSummaryTable,
  lintSummaryExitCode,
  parseLintReport,
  runLintSummary,
} from "../../src/cli/commands/lint-summary"
import type { LintReport } from "../../src/cli/lint-report"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-lint-summary-"))
}

function report(over: Partial<LintReport>): LintReport {
  return {
    version: 1,
    package: "pkg",
    timestamp: "2026-08-10T21:00:00.000Z",
    fix: false,
    errorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    fileCount: 0,
    files: [],
    ...over,
  }
}

/** Write a report into <root>/<pkgDir>/.ts-builds/lint-report.json. */
function seed(root: string, pkgDir: string, r: LintReport): void {
  const dir = join(root, pkgDir, ".ts-builds")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "lint-report.json"), JSON.stringify(r))
}

describe("findLintReports", () => {
  it("finds sidecars across packages and skips node_modules/dist/hidden dirs", async () => {
    const root = makeTempDir()
    try {
      seed(root, "packages/a", report({ package: "a" }))
      seed(root, "packages/b", report({ package: "b" }))
      // Should be ignored:
      seed(root, "node_modules/dep", report({ package: "dep" }))
      seed(root, "dist", report({ package: "dist-junk" }))
      seed(root, ".git/hooks", report({ package: "git-junk" }))

      const found = await findLintReports(root)
      expect(found).toHaveLength(2)
      expect(found.every((p) => p.includes(join("packages", "a")) || p.includes(join("packages", "b")))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns empty for a tree with no sidecars", async () => {
    const root = makeTempDir()
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      expect(await findLintReports(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("aggregateLintReports", () => {
  it("sums counts, sorts by package, and counts fatals", () => {
    const totals = aggregateLintReports([
      report({ package: "z", errorCount: 1, warningCount: 2 }),
      report({ package: "a", warningCount: 3 }),
      report({ package: "m", fatal: true }),
    ])
    expect(totals.rows.map((r) => r.package)).toEqual(["a", "m", "z"])
    expect(totals.totalErrors).toBe(1)
    expect(totals.totalWarnings).toBe(5)
    expect(totals.fatalCount).toBe(1)
  })
})

describe("lintSummaryExitCode", () => {
  it("is nonzero on errors", () => {
    expect(lintSummaryExitCode(aggregateLintReports([report({ errorCount: 1 })]))).toBe(1)
  })
  it("is nonzero on a fatal even with zero errors", () => {
    expect(lintSummaryExitCode(aggregateLintReports([report({ fatal: true })]))).toBe(1)
  })
  it("is zero when only warnings", () => {
    expect(lintSummaryExitCode(aggregateLintReports([report({ warningCount: 9 })]))).toBe(0)
  })
  it("is zero when fully clean", () => {
    expect(lintSummaryExitCode(aggregateLintReports([report({})]))).toBe(0)
  })
})

describe("formatLintSummaryTable", () => {
  it("renders rows, a fatal marker, and a Total footer", () => {
    const table = formatLintSummaryTable(
      aggregateLintReports([report({ package: "a", errorCount: 2 }), report({ package: "b", fatal: true })]),
    )
    expect(table).toContain("Package")
    expect(table).toContain("b (fatal)")
    expect(table).toMatch(/Total\s+2\s+0/)
  })

  it("shows the date (not just time) so a stale report is visibly older", () => {
    const table = formatLintSummaryTable(
      aggregateLintReports([report({ package: "a", timestamp: "2026-08-11T21:05:00.000Z" })]),
    )
    expect(table).toContain("When (UTC)")
    expect(table).toContain("2026-08-11 21:05")
  })
})

describe("parseLintReport", () => {
  it("accepts a well-formed report", () => {
    expect(parseLintReport(JSON.stringify(report({ package: "a", errorCount: 1 })))?.package).toBe("a")
  })
  it("rejects invalid JSON", () => {
    expect(parseLintReport("{not json")).toBeNull()
  })
  it("rejects a wrong version", () => {
    expect(parseLintReport(JSON.stringify({ ...report({}), version: 999 }))).toBeNull()
  })
  it("rejects non-numeric counts (would poison the aggregate with NaN)", () => {
    const bad = { ...report({}), errorCount: undefined }
    expect(parseLintReport(JSON.stringify(bad))).toBeNull()
  })
})

describe("invalid reports gate CI", () => {
  it("counts invalid reports toward the exit code", () => {
    expect(lintSummaryExitCode(aggregateLintReports([report({})], 1))).toBe(1)
  })

  it("runLintSummary exits nonzero when a sidecar is malformed even if the rest are clean", async () => {
    const root = makeTempDir()
    try {
      seed(root, "clean", report({ package: "clean" }))
      // A truncated/garbage sidecar, e.g. from a task killed mid-write.
      const bad = join(root, "broken", ".ts-builds")
      mkdirSync(bad, { recursive: true })
      writeFileSync(join(bad, "lint-report.json"), '{"version":1,"package":"broken"')
      expect(await runLintSummary([root])).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("findLintReports package-name collisions", () => {
  it("includes a workspace package literally named 'lib' (has package.json)", async () => {
    const root = makeTempDir()
    try {
      // a real package named lib/ — must be summarized despite the skip list
      mkdirSync(join(root, "lib"), { recursive: true })
      writeFileSync(join(root, "lib", "package.json"), "{}")
      seed(root, "lib", report({ package: "lib" }))
      // a plain build-output dir named dist/ (no package.json) — must be skipped
      seed(root, "dist", report({ package: "dist-junk" }))
      const found = await findLintReports(root)
      expect(found.some((p) => p.includes(join("lib", ".ts-builds")))).toBe(true)
      expect(found.some((p) => p.includes(join("dist", ".ts-builds")))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("runLintSummary", () => {
  it("returns nonzero when no reports are found", async () => {
    const root = makeTempDir()
    try {
      expect(await runLintSummary([root])).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("aggregates found reports and gates on errors", async () => {
    const root = makeTempDir()
    try {
      seed(root, "a", report({ package: "a", errorCount: 3 }))
      seed(root, "b", report({ package: "b", warningCount: 1 }))
      expect(await runLintSummary([root])).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns zero when all found reports are clean", async () => {
    const root = makeTempDir()
    try {
      seed(root, "a", report({ package: "a" }))
      expect(await runLintSummary([root])).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
