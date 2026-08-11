import { existsSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { targetDir } from "../config"
import { LINT_REPORT_VERSION, type LintReport } from "../lint-report"

/** node_modules is always skipped: huge, and never a workspace package itself. */
const ALWAYS_SKIP = new Set(["node_modules"])
/** Skipped ONLY when the dir is not itself a package — a workspace package literally
 * named `lib`/`dist`/`coverage` must still be summarized, so we check for package.json. */
const SKIP_UNLESS_PACKAGE = new Set(["dist", "lib", "coverage"])

/**
 * Recursively find every `.ts-builds/lint-report.json` under `root`.
 *
 * Hand-rolled walk rather than `fs.promises.glob`, which is still experimental on
 * Node 22 (this repo's `engines` floor) and would print an ExperimentalWarning in
 * consumers' CI logs. Symlinked directories are never traversed: with `withFileTypes`,
 * `readdir` does not resolve symlinks, so a symlink-to-dir reports `isDirectory() ===
 * false` and is skipped by the guard below (no cycles, no escaping the tree).
 */
export async function findLintReports(root: string): Promise<string[]> {
  const out: string[] = []
  await walk(root, out)
  return out.sort()
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue // skips files AND symlinks (see findLintReports)
    if (entry.name === ".ts-builds") {
      const report = join(dir, entry.name, "lint-report.json")
      if (existsSync(report)) out.push(report)
      continue
    }
    // Hidden dirs (.git, .idea, .cache) and node_modules are always skipped.
    if (entry.name.startsWith(".") || ALWAYS_SKIP.has(entry.name)) continue
    const sub = join(dir, entry.name)
    // dist/lib/coverage are skipped unless they're actually a package.
    if (SKIP_UNLESS_PACKAGE.has(entry.name) && !existsSync(join(sub, "package.json"))) continue
    await walk(sub, out)
  }
}

export interface LintSummaryRow {
  package: string
  errorCount: number
  warningCount: number
  fatal: boolean
  timestamp: string
}

export interface LintSummaryTotals {
  rows: LintSummaryRow[]
  totalErrors: number
  totalWarnings: number
  fatalCount: number
  /** Sidecars that existed but were unreadable/malformed/wrong-version. Counted
   * toward the exit code — a report we can't trust must not read as "clean". */
  invalidCount: number
}

/**
 * Validate a parsed sidecar. A wrong-shape or wrong-version file must NOT flow into
 * the aggregate: `undefined` counts would poison the reduce (`NaN > 0 === false`) and
 * silently pass CI. Returns the typed report or null (caller counts nulls as invalid).
 */
export function parseLintReport(raw: string): LintReport | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof obj !== "object" || obj === null) return null
  const r = obj as Record<string, unknown>
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  if (r.version !== LINT_REPORT_VERSION) return null
  if (typeof r.package !== "string" || typeof r.timestamp !== "string") return null
  if (!isNum(r.errorCount) || !isNum(r.warningCount)) return null
  if (r.fatal !== undefined && typeof r.fatal !== "boolean") return null
  return obj as LintReport
}

/** Aggregate parsed reports into per-package rows and grand totals. */
export function aggregateLintReports(reports: readonly LintReport[], invalidCount = 0): LintSummaryTotals {
  const rows = reports
    .map((r) => ({
      package: r.package,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
      fatal: r.fatal === true,
      timestamp: r.timestamp,
    }))
    .sort((a, b) => a.package.localeCompare(b.package))

  return {
    rows,
    totalErrors: rows.reduce((n, r) => n + r.errorCount, 0),
    totalWarnings: rows.reduce((n, r) => n + r.warningCount, 0),
    fatalCount: rows.filter((r) => r.fatal).length,
    invalidCount,
  }
}

/** Nonzero iff any package has errors, crashed, or produced an untrustworthy report. */
export function lintSummaryExitCode(totals: LintSummaryTotals): number {
  return totals.totalErrors > 0 || totals.fatalCount > 0 || totals.invalidCount > 0 ? 1 : 0
}

/** `YYYY-MM-DD HH:MM` (UTC) from an ISO timestamp — keeps the DATE so a stale
 * half-sweep is visibly older than a fresh one. */
function shortTimestamp(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso)
  return m ? `${m[1]} ${m[2]}` : iso
}

/** Render the aggregate as a padded table with a `Total` footer (matches size.ts). */
export function formatLintSummaryTable(totals: LintSummaryTotals): string {
  const { rows } = totals
  const nameWidth = Math.max("Package".length, ...rows.map((r) => r.package.length + (r.fatal ? 8 : 0)))
  const numWidth = 8
  const timeWidth = 16 // "YYYY-MM-DD HH:MM"

  const label = (r: LintSummaryRow): string => (r.fatal ? `${r.package} (fatal)` : r.package)
  const header = `${"Package".padEnd(nameWidth)}  ${"Errors".padStart(numWidth)}  ${"Warnings".padStart(numWidth)}  ${"When (UTC)".padStart(timeWidth)}`
  const lines = [header, "-".repeat(header.length)]

  for (const r of rows) {
    lines.push(
      `${label(r).padEnd(nameWidth)}  ${String(r.errorCount).padStart(numWidth)}  ${String(r.warningCount).padStart(numWidth)}  ${shortTimestamp(r.timestamp).padStart(timeWidth)}`,
    )
  }

  lines.push("-".repeat(header.length))
  lines.push(
    `${"Total".padEnd(nameWidth)}  ${String(totals.totalErrors).padStart(numWidth)}  ${String(totals.totalWarnings).padStart(numWidth)}  ${"".padStart(timeWidth)}`,
  )
  return lines.join("\n")
}

/**
 * `ts-builds lint:summary [dir]` — aggregate per-package lint sidecars into one total.
 *
 * Read-only: it never re-runs ESLint, only reads the `.ts-builds/lint-report.json`
 * files that `ts-builds lint` (or a `turbo run lint`) already wrote. The CI gate fails
 * CLOSED: finding zero reports, or a report that is unreadable/malformed/wrong-version,
 * exits nonzero. An empty sweep (wrong dir, fresh clone, missing Turbo `outputs`
 * declaration) or a truncated sidecar must not green-light CI on absent evidence.
 */
export async function runLintSummary(args: string[]): Promise<number> {
  const dirArg = args.find((a) => !a.startsWith("-"))
  const root = dirArg ? (isAbsolute(dirArg) ? dirArg : join(targetDir, dirArg)) : targetDir

  const paths = await findLintReports(root)
  if (paths.length === 0) {
    console.error(
      `No lint reports found under ${root}.\n` +
        `Run 'ts-builds lint' (or 'turbo run lint') first. In a monorepo, declare\n` +
        `'.ts-builds/**' as a Turbo task output so cached runs still restore the reports.`,
    )
    return 1
  }

  const reports: LintReport[] = []
  let invalidCount = 0
  for (const path of paths) {
    const report = parseLintReport(readFileSync(path, "utf-8"))
    if (report) {
      reports.push(report)
    } else {
      invalidCount++
      console.warn(`⚠  Unreadable or malformed lint report (counted as a failure): ${path}`)
    }
  }

  const totals = aggregateLintReports(reports, invalidCount)
  if (reports.length > 0) {
    console.log(formatLintSummaryTable(totals))
    console.log()
  }
  console.log(
    `Summary: ${totals.totalErrors} error(s), ${totals.totalWarnings} warning(s) across ${reports.length} package(s)` +
      (totals.fatalCount > 0 ? `, ${totals.fatalCount} crashed` : "") +
      (invalidCount > 0 ? `, ${invalidCount} unreadable` : ""),
  )
  return lintSummaryExitCode(totals)
}
