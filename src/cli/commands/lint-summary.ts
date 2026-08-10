import { existsSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { targetDir } from "../config"
import type { LintReport } from "../lint-report"

/** Directories never worth descending into when hunting for sidecars. */
const SKIP_DIRS = new Set(["node_modules", "dist", "lib", "coverage"])

/**
 * Recursively find every `.ts-builds/lint-report.json` under `root`.
 *
 * Hand-rolled walk rather than `fs.promises.glob`, which is still experimental on
 * Node 22 (this repo's `engines` floor) and would print an ExperimentalWarning in
 * consumers' CI logs. Skips heavy/irrelevant dirs, does not follow symlinks (avoids
 * cycles and escaping the tree), and does not recurse INTO `.ts-builds` itself.
 */
export async function findLintReports(root: string): Promise<string[]> {
  const out: string[] = []
  await walk(root, out)
  return out.sort()
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name === ".ts-builds") {
      const report = join(dir, entry.name, "lint-report.json")
      if (existsSync(report)) out.push(report)
      continue
    }
    // Skip node_modules/dist/… and any other hidden dir (.git, .idea, .cache).
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
    await walk(join(dir, entry.name), out)
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
}

/** Aggregate parsed reports into per-package rows and grand totals. */
export function aggregateLintReports(reports: readonly LintReport[]): LintSummaryTotals {
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
  }
}

/** Nonzero iff any package has errors or crashed — the CI gate. */
export function lintSummaryExitCode(totals: LintSummaryTotals): number {
  return totals.totalErrors > 0 || totals.fatalCount > 0 ? 1 : 0
}

/** Short `HH:MM:SS` slice of an ISO timestamp for the staleness column. */
function shortTime(iso: string): string {
  const t = iso.split("T")[1]
  return t ? t.slice(0, 8) : iso
}

/** Render the aggregate as a padded table with a `Total` footer (matches size.ts). */
export function formatLintSummaryTable(totals: LintSummaryTotals): string {
  const { rows } = totals
  const nameWidth = Math.max("Package".length, ...rows.map((r) => r.package.length + (r.fatal ? 8 : 0)))
  const numWidth = 8
  const timeWidth = 8

  const label = (r: LintSummaryRow): string => (r.fatal ? `${r.package} (fatal)` : r.package)
  const header = `${"Package".padEnd(nameWidth)}  ${"Errors".padStart(numWidth)}  ${"Warnings".padStart(numWidth)}  ${"When".padStart(timeWidth)}`
  const lines = [header, "-".repeat(header.length)]

  for (const r of rows) {
    lines.push(
      `${label(r).padEnd(nameWidth)}  ${String(r.errorCount).padStart(numWidth)}  ${String(r.warningCount).padStart(numWidth)}  ${shortTime(r.timestamp).padStart(timeWidth)}`,
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
 * files that `ts-builds lint` (or a `turbo run lint`) already wrote. Finding ZERO
 * reports exits nonzero — an empty sweep (wrong dir, fresh clone, missing Turbo
 * `outputs` declaration) must not green-light CI on no evidence.
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
  for (const path of paths) {
    try {
      reports.push(JSON.parse(readFileSync(path, "utf-8")) as LintReport)
    } catch {
      console.warn(`⚠  Skipping unreadable lint report: ${path}`)
    }
  }

  if (reports.length === 0) {
    console.error(`Found ${paths.length} lint report file(s) but none could be parsed.`)
    return 1
  }

  const totals = aggregateLintReports(reports)
  console.log(formatLintSummaryTable(totals))
  console.log()
  console.log(
    `Summary: ${totals.totalErrors} error(s), ${totals.totalWarnings} warning(s) across ${reports.length} package(s)` +
      (totals.fatalCount > 0 ? `, ${totals.fatalCount} crashed` : ""),
  )
  return lintSummaryExitCode(totals)
}
