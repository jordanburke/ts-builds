import { rm } from "node:fs/promises"
import { join } from "node:path"

import { loadConfig, targetDir } from "../config"
import { runCommand } from "../process"

const TRANSIENT_RM_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE"])
const RETRY_DELAYS_MS = [100, 250, 500, 1000]

/**
 * Recursively remove a directory with retries on transient filesystem errors.
 *
 * On Windows, antivirus scanners, file watchers, and IDE indexers can briefly
 * hold file handles in `dist/` right after a build, causing `fs.rm` to fail
 * with EBUSY/EPERM/ENOTEMPTY/EMFILE. `rimraf` papered over this with retries;
 * we keep the same robustness without the install-graph dependency.
 *
 * Returns 0 on success (including when the directory didn't exist),
 * 1 if every retry failed.
 */
export async function cleanDir(absPath: string): Promise<number> {
  const attempts = RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(absPath, { recursive: true, force: true })
      return 0
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ""
      const isLastAttempt = attempt === attempts - 1
      if (!TRANSIENT_RM_ERRORS.has(code) || isLastAttempt) {
        console.error(`Failed to clean ${absPath}: ${(err as Error).message}`)
        return 1
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  return 1
}

async function cleanDist(): Promise<number> {
  return cleanDir(join(targetDir, "dist"))
}

export async function runFormat(check = false): Promise<number> {
  const args = check ? ["--check", "."] : ["--write", "."]
  return runCommand("prettier", args)
}

export async function runLint(check = false): Promise<number> {
  const config = loadConfig()
  const eslintCmd = config.lint.useProjectEslint ? "npx eslint" : "eslint"
  const args = check ? [config.srcDir] : ["--fix", config.srcDir]
  return runCommand(eslintCmd, args)
}

export async function runTypecheck(): Promise<number> {
  return runCommand("tsc", ["--noEmit"])
}

export async function runTest(mode: "run" | "watch" | "coverage" | "ui" = "run"): Promise<number> {
  switch (mode) {
    case "watch":
      return runCommand("vitest", [])
    case "coverage":
      return runCommand("vitest", ["run", "--coverage"])
    case "ui":
      return runCommand("vitest", ["--ui"])
    default:
      return runCommand("vitest", ["run"])
  }
}

/**
 * Production build (or watch build, when `watch === true`).
 *
 * Two design choices worth knowing about before editing:
 *
 * 1. **Clean is done via Node's `fs.rm`, not a shelled-out `rimraf`.**
 *    See {@link cleanDir} — it handles the Windows transient-error cases
 *    that `rimraf` previously papered over, without dragging `rimraf` into
 *    consumers' install graphs.
 *
 * 2. **`NODE_ENV=production` is passed through `spawn`'s `env` option, not
 *    by assigning `process.env.NODE_ENV` in the parent process.** Mutating
 *    `process.env` would leak production semantics into any later code in
 *    the same process — fine for the one-shot CLI binary, dangerous when
 *    `runBuild` is imported into a long-lived runner. See `RunOptions.env`
 *    in `src/cli/process.ts` for the contract.
 *
 * Watch mode skips the clean (tsdown/vite manage their own watch output).
 */
export async function runBuild(watch = false): Promise<number> {
  const config = loadConfig()

  if (config.buildMode === "vite") {
    if (watch) return runCommand("vite", ["build", "--watch"])
    const cleanCode = await cleanDist()
    if (cleanCode !== 0) return cleanCode
    return runCommand("vite", ["build"])
  }

  if (watch) return runCommand("tsdown", ["--watch"])
  const cleanCode = await cleanDist()
  if (cleanCode !== 0) return cleanCode
  return runCommand("tsdown", [], { env: { NODE_ENV: "production" } })
}

export async function runDev(): Promise<number> {
  const config = loadConfig()
  return config.buildMode === "vite" ? runCommand("vite", []) : runCommand("tsdown", ["--watch"])
}
