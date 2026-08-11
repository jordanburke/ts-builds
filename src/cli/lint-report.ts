import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import type { ESLint } from "eslint"

import { targetDir } from "./config"

/**
 * Current sidecar schema version. Bump when the shape changes incompatibly so
 * `lint:summary` can detect and skip reports it can't read.
 */
export const LINT_REPORT_VERSION = 1

/** Per-file issue rollup. Deliberately NOT the ESLint messages — replaying every
 * message in `lint:summary` would recreate the exact scroll the aggregate is meant
 * to replace. Counts are enough for the table. */
export interface LintReportFile {
  filePath: string
  errorCount: number
  warningCount: number
}

/**
 * Machine-readable per-package lint result written to `.ts-builds/lint-report.json`.
 *
 * `fix` records the mode: the default `validate` chain runs lint in FIX mode, so
 * its counts are POST-fix remaining issues; a bare `lint:check` records all. It is
 * recorded for diagnostics; `lint:summary` does not currently split totals by mode.
 * `fatal` marks a run that threw (bad config, no matching files) — the counts are
 * zero but the package must still count as failed, never as clean.
 */
export interface LintReport {
  version: number
  package: string
  timestamp: string
  fix: boolean
  fatal?: boolean
  errorCount: number
  warningCount: number
  fixableErrorCount: number
  fixableWarningCount: number
  fileCount: number
  files: LintReportFile[]
}

/** Absolute path to a package's lint sidecar. `dir` is the package root. */
export function lintReportPath(dir: string = targetDir): string {
  return join(dir, ".ts-builds", "lint-report.json")
}

/** Package name from `<dir>/package.json`, falling back to the directory name. */
export function readPackageName(dir: string = targetDir): string {
  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const name = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string }).name
      if (typeof name === "string" && name.length > 0) return name
    } catch {
      // fall through to basename
    }
  }
  return basename(dir)
}

/** Build a report from ESLint results. */
export function buildLintReport(results: readonly ESLint.LintResult[], fix: boolean, pkg: string): LintReport {
  const acc = results.reduce(
    (a, r) => ({
      errorCount: a.errorCount + r.errorCount,
      warningCount: a.warningCount + r.warningCount,
      fixableErrorCount: a.fixableErrorCount + r.fixableErrorCount,
      fixableWarningCount: a.fixableWarningCount + r.fixableWarningCount,
    }),
    { errorCount: 0, warningCount: 0, fixableErrorCount: 0, fixableWarningCount: 0 },
  )
  return {
    version: LINT_REPORT_VERSION,
    package: pkg,
    timestamp: new Date().toISOString(),
    fix,
    ...acc,
    fileCount: results.length,
    files: results
      .filter((r) => r.errorCount > 0 || r.warningCount > 0)
      .map((r) => ({ filePath: r.filePath, errorCount: r.errorCount, warningCount: r.warningCount })),
  }
}

/** Build a fatal report for a run that threw before producing results. */
export function fatalLintReport(fix: boolean, pkg: string): LintReport {
  return {
    version: LINT_REPORT_VERSION,
    package: pkg,
    timestamp: new Date().toISOString(),
    fix,
    fatal: true,
    errorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    fileCount: 0,
    files: [],
  }
}

/** Write the sidecar to `<dir>/.ts-builds/lint-report.json`.
 *
 * Written atomically (temp file + `rename`) so a run killed mid-write — e.g. Turbo's
 * default `--continue=never` SIGTERMing sibling tasks on the first failure — never
 * leaves truncated JSON that `lint:summary` would have to guess at. Best-effort: a
 * write failure warns but never fails the lint run itself. */
export async function writeLintReport(report: LintReport, dir: string = targetDir): Promise<void> {
  const path = lintReportPath(dir)
  const tmp = `${path}.tmp`
  try {
    await mkdir(join(dir, ".ts-builds"), { recursive: true })
    await writeFile(tmp, JSON.stringify(report, null, 2) + "\n")
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    console.warn(`⚠  Could not write lint report to ${path}: ${(err as Error).message}`)
  }
}
