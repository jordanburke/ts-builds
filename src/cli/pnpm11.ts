import { existsSync, readFileSync } from "node:fs"
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
