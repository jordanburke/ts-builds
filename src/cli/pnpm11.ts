import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { List } from "functype"

import type { CheckResult } from "./commands/doctor"
import { targetDir } from "./config"

const HOIST_LINE = /^public-hoist-pattern\[\]=(.+)$/

function readHoistPatterns(npmrc: string): string[] {
  return npmrc
    .split("\n")
    .map((line) => HOIST_LINE.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1])
}

export function detectPnpm11Issues(dir: string = targetDir): List<CheckResult> {
  const results: CheckResult[] = []

  const npmrcPath = join(dir, ".npmrc")
  const npmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf-8") : ""
  const hoistCount = readHoistPatterns(npmrc).length
  if (hoistCount > 0) {
    results.push({
      severity: "warning",
      message: `${hoistCount} hoist pattern(s) in .npmrc are ignored by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml`,
    })
  }

  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pnpm?: Record<string, unknown> }
    if (pkg.pnpm && typeof pkg.pnpm === "object" && Object.keys(pkg.pnpm).length > 0) {
      results.push({
        severity: "warning",
        message: `package.json 'pnpm' field is no longer read by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml`,
      })
    }
  }

  if (results.length === 0) {
    results.push({ severity: "info", message: "pnpm 11 ready" })
  }

  return List(results)
}

export type MigrationAction = {
  kind: "migrated" | "removed" | "skipped" | "manual"
  message: string
}

export type MigrationReport = {
  actions: MigrationAction[]
  errors: number
}

type PnpmField = {
  overrides?: Record<string, string>
  peerDependencyRules?: {
    allowedVersions?: Record<string, string>
    ignoreMissing?: string[]
  }
  [key: string]: unknown
}

const NPMRC_HEADER = "# Hoist CLI tool binaries from peer dependencies"
const KNOWN_PNPM_KEYS = new Set(["overrides", "peerDependencyRules"])

function hasTopLevelKey(yaml: string, key: string): boolean {
  return new RegExp(`^${key}:`, "m").test(yaml)
}

function appendBlock(existing: string, block: string): string {
  if (existing.length === 0) return block
  const base = existing.endsWith("\n") ? existing : existing + "\n"
  return base + "\n" + block
}

function renderPublicHoistPattern(patterns: string[]): string {
  return "publicHoistPattern:\n" + patterns.map((p) => `  - "${p}"`).join("\n") + "\n"
}

function renderOverrides(overrides: Record<string, string>): string {
  return (
    "overrides:\n" +
    Object.entries(overrides)
      .map(([k, v]) => `  "${k}": "${v}"`)
      .join("\n") +
    "\n"
  )
}

function renderPeerDependencyRules(rules: NonNullable<PnpmField["peerDependencyRules"]>): string {
  const lines = ["peerDependencyRules:"]
  if (rules.allowedVersions && Object.keys(rules.allowedVersions).length > 0) {
    lines.push("  allowedVersions:")
    for (const [k, v] of Object.entries(rules.allowedVersions)) {
      lines.push(`    "${k}": "${v}"`)
    }
  }
  if (rules.ignoreMissing && rules.ignoreMissing.length > 0) {
    lines.push("  ignoreMissing:")
    for (const name of rules.ignoreMissing) {
      lines.push(`    - "${name}"`)
    }
  }
  return lines.join("\n") + "\n"
}

function safeWrite(path: string, content: string): boolean {
  try {
    writeFileSync(path, content)
    return true
  } catch {
    return false
  }
}

export function migratePnpm11(dir: string = targetDir): MigrationReport {
  const actions: MigrationAction[] = []
  let errors = 0
  // Destructive edits to the SOURCE files are deferred until the destination
  // (pnpm-workspace.yaml) is safely on disk — otherwise a failed ws write would
  // lose config that was already stripped from .npmrc / package.json.
  const sourceMutations: Array<() => void> = []

  const wsPath = join(dir, "pnpm-workspace.yaml")
  const wsExists = existsSync(wsPath) && statSync(wsPath).isFile()
  let ws = wsExists ? readFileSync(wsPath, "utf-8") : ""
  let wsChanged = false

  // (a) .npmrc hoist patterns -> pnpm-workspace.yaml
  const npmrcPath = join(dir, ".npmrc")
  if (existsSync(npmrcPath)) {
    const npmrc = readFileSync(npmrcPath, "utf-8")
    const patterns = readHoistPatterns(npmrc)
    if (patterns.length > 0) {
      if (hasTopLevelKey(ws, "publicHoistPattern")) {
        actions.push({
          kind: "skipped",
          message: "publicHoistPattern already in pnpm-workspace.yaml — left .npmrc lines for manual review",
        })
      } else {
        ws = appendBlock(ws, renderPublicHoistPattern(patterns))
        wsChanged = true
        actions.push({
          kind: "migrated",
          message: `Migrated ${patterns.length} hoist pattern(s) to pnpm-workspace.yaml`,
        })

        const remaining = npmrc
          .split("\n")
          .filter((line) => {
            const t = line.trim()
            return !HOIST_LINE.test(t) && t !== NPMRC_HEADER
          })
          .join("\n")

        sourceMutations.push(() => {
          if (remaining.trim() === "") {
            try {
              rmSync(npmrcPath)
              actions.push({ kind: "removed", message: "Removed empty .npmrc" })
            } catch {
              errors++
              actions.push({
                kind: "manual",
                message: "Could not remove .npmrc — delete the migrated hoist lines manually",
              })
            }
          } else if (!safeWrite(npmrcPath, remaining.endsWith("\n") ? remaining : remaining + "\n")) {
            errors++
            actions.push({
              kind: "manual",
              message: "Could not rewrite .npmrc — delete the migrated hoist lines manually",
            })
          }
        })
      }
    }
  }

  // (b) package.json pnpm field -> pnpm-workspace.yaml
  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pnpm?: PnpmField; [k: string]: unknown }
    const pnpm = pkg.pnpm
    if (pnpm && typeof pnpm === "object") {
      let pkgChanged = false

      if (pnpm.overrides && Object.keys(pnpm.overrides).length > 0) {
        if (hasTopLevelKey(ws, "overrides")) {
          actions.push({ kind: "skipped", message: "overrides already in pnpm-workspace.yaml — reconcile manually" })
        } else {
          ws = appendBlock(ws, renderOverrides(pnpm.overrides))
          wsChanged = true
          delete pnpm.overrides
          pkgChanged = true
          actions.push({ kind: "migrated", message: "Migrated pnpm.overrides" })
        }
      }

      if (pnpm.peerDependencyRules && Object.keys(pnpm.peerDependencyRules).length > 0) {
        if (hasTopLevelKey(ws, "peerDependencyRules")) {
          actions.push({
            kind: "skipped",
            message: "peerDependencyRules already in pnpm-workspace.yaml — reconcile manually",
          })
        } else {
          ws = appendBlock(ws, renderPeerDependencyRules(pnpm.peerDependencyRules))
          wsChanged = true
          delete pnpm.peerDependencyRules
          pkgChanged = true
          actions.push({ kind: "migrated", message: "Migrated pnpm.peerDependencyRules" })
        }
      }

      for (const key of Object.keys(pnpm)) {
        if (!KNOWN_PNPM_KEYS.has(key)) {
          actions.push({ kind: "manual", message: `pnpm.${key} needs manual migration (left in package.json)` })
        }
      }

      if (Object.keys(pnpm).length === 0) {
        delete pkg.pnpm
        pkgChanged = true
      }

      if (pkgChanged) {
        sourceMutations.push(() => {
          if (!safeWrite(pkgPath, JSON.stringify(pkg, null, 2) + "\n")) {
            errors++
            actions.push({
              kind: "manual",
              message: "Could not rewrite package.json — remove the migrated pnpm field keys manually",
            })
          }
        })
      }
    }
  }

  // Write the destination FIRST. If it fails, leave the source files untouched.
  if (wsChanged && !safeWrite(wsPath, ws)) {
    errors++
    actions.push({
      kind: "manual",
      message: "Could not write pnpm-workspace.yaml — no changes made to .npmrc or package.json",
    })
    return { actions, errors }
  }

  for (const mutate of sourceMutations) {
    mutate()
  }

  return { actions, errors }
}
