import { existsSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadConfig, targetDir } from "../config"
import { buildLintReport, fatalLintReport, readPackageName, writeLintReport } from "../lint-report"
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

/**
 * Absolute path to ts-builds' own bundled `.prettierignore` (lockfiles, dist, coverage, …), or
 * null if it can't be located. Resolved relative to this module — which tsdown bundles into
 * `dist/cli.js` — so `../.prettierignore` is the installed package root regardless of the
 * consumer's cwd. Exported so a unit test pins the resolution (a future build layout change that
 * broke it would otherwise silently degrade to bare formatting). The `existsSync` guard makes a
 * missing asset fall back to bare discovery rather than break `format` outright.
 */
export function bundledPrettierIgnorePath(): string | null {
  const p = fileURLToPath(new URL("../.prettierignore", import.meta.url))
  return existsSync(p) ? p : null
}

/**
 * prettier CLI args for `format` / `format:check`.
 *
 * prettier only auto-discovers the CONSUMER's `./.prettierignore` — never ours — so a bare
 * `prettier .` still walks into `pnpm-lock.yaml` (and dist/coverage) in every consuming repo. We
 * pass our bundled ignore explicitly. An explicit `--ignore-path` OVERRIDES prettier's default
 * discovery (verified, prettier 3.9), so we ALSO pass the consumer's `./.prettierignore`: the two
 * compose additively, and a missing consumer file is tolerated silently. Net — lockfiles/build
 * output are ignored for every consumer with no per-repo `.prettierignore` needed, while the
 * consumer's own entries still apply.
 *
 * The bundled path is quoted because `runCommand` spawns with `shell: true` (the shell strips the
 * quotes), keeping it correct when the install path contains spaces.
 */
export function prettierFormatArgs(
  check: boolean,
  bundledIgnore: string | null = bundledPrettierIgnorePath(),
): string[] {
  const base = [check ? "--check" : "--write", "."]
  return bundledIgnore ? [...base, "--ignore-path", `"${bundledIgnore}"`, "--ignore-path", ".prettierignore"] : base
}

export async function runFormat(check = false): Promise<number> {
  return runCommand("prettier", prettierFormatArgs(check))
}

/**
 * Await a full write to a stream before resolving.
 *
 * Under a task runner (Turbo, nx) stdout is a pipe. Writing a large buffer with
 * `stream.write(data)` and then letting the process exit can truncate the tail
 * on a pipe — a documented case, and this repo already treats Windows pipe/handle
 * quirks as real (see {@link cleanDir}). The write callback fires once the chunk
 * has been flushed to the underlying resource, so awaiting it before the CLI calls
 * `process.exit` guarantees the stylish output lands intact.
 */
function writeAll(stream: NodeJS.WritableStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Lint `srcDir`.
 *
 * Bundled path (default, `useProjectEslint: false`): runs ESLint through its Node
 * API in a single pass, so we get the familiar stylish output AND exact issue
 * counts for the `.ts-builds/lint-report.json` sidecar that `lint:summary`
 * aggregates. `import("eslint")` resolves ts-builds' OWN bundled eslint — the same
 * package the spawned PATH binary resolved to before — because tsdown externalizes
 * dependencies rather than inlining them.
 *
 * Project path (`useProjectEslint: true`): keeps the spawn to the consumer's eslint
 * (which may be a different major with a different Node API). That path writes NO
 * sidecar and prints no warning; those packages simply don't appear in `lint:summary`
 * (documented). Returns 0/1 iff there are lint errors.
 *
 * Exit codes are RETURNED, never `process.exit`ed: `runLint` runs in-process inside
 * the `validate` chain (see runner.ts), so exiting here would kill the chain with no
 * `✗ lint failed` line. `cli.ts` owns process exit. Bundled path: 1 iff errorCount>0,
 * 0 on warnings-only/clean, 2 on a thrown config/no-files error (and a `fatal` sidecar
 * is written so a stale prior report can't green-light CI).
 */
export async function runLint(check = false): Promise<number> {
  const config = loadConfig()

  if (config.lint.useProjectEslint) {
    const args = check ? [config.srcDir] : ["--fix", config.srcDir]
    return runCommand("npx eslint", args)
  }

  const fix = !check
  const pkg = readPackageName(targetDir)
  const { ESLint } = await import("eslint")
  const eslint = new ESLint({ fix, cwd: targetDir })

  let results
  try {
    results = await eslint.lintFiles([config.srcDir])
  } catch (err) {
    console.error((err as Error).message)
    await writeLintReport(fatalLintReport(fix, pkg), targetDir)
    return 2
  }

  if (fix) await ESLint.outputFixes(results)

  const formatter = await eslint.loadFormatter("stylish")
  const output = await formatter.format(results)
  if (output) await writeAll(process.stdout, output)

  await writeLintReport(buildLintReport(results, fix, pkg), targetDir)

  const errorCount = results.reduce((n, r) => n + r.errorCount, 0)
  return errorCount > 0 ? 1 : 0
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
 * Recursively map every file under `dir` to its mtime (ms). Returns an empty
 * map when `dir` doesn't exist. Best-effort: unreadable entries are skipped.
 */
export async function snapshotMtimes(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [p, m] of await snapshotMtimes(path)) out.set(p, m)
    } else {
      const mtime = await stat(path)
        .then((s) => s.mtimeMs)
        .catch(() => undefined)
      if (mtime !== undefined) out.set(path, mtime)
    }
  }
  return out
}

/**
 * Non-destructive clean: remove only the build outputs left *untouched* by the
 * latest build — orphans from a previous build whose source entry no longer
 * exists (including old content-hashed chunk files).
 *
 * A file is an orphan iff it was present in `before` AND its mtime is unchanged
 * afterwards: tsdown rewrites every current output, so anything it produced has
 * a newer mtime, and anything still bearing its pre-build mtime is stale. This
 * yields the same orphan-free result as `rm -rf dist` without ever unlinking a
 * file mid-build — see {@link runBuild}.
 *
 * Best-effort: a failed unlink leaves a (harmless) orphan rather than failing
 * the build.
 */
export async function pruneOrphans(distDir: string, before: Map<string, number>): Promise<void> {
  for (const [path, mtimeBefore] of before) {
    const mtimeNow = await stat(path)
      .then((s) => s.mtimeMs)
      .catch(() => undefined)
    if (mtimeNow === mtimeBefore) {
      await rm(path, { force: true }).catch(() => undefined)
    }
  }
}

/**
 * Production build (or watch build, when `watch === true`).
 *
 * Three design choices worth knowing about before editing:
 *
 * 1. **Non-destructive clean (tsdown path).** Rather than `rm -rf dist` before
 *    building — which leaves a window where `dist/` is empty and a concurrent
 *    reader (e.g. a sibling package's tests executing this package's built
 *    output under a monorepo task runner) hits "Cannot find module" — we build
 *    over the existing `dist` with `--no-clean` (overriding `clean: true` in
 *    the shared tsdown base config, so outputs are overwritten in place and
 *    `dist` is never momentarily empty), then {@link pruneOrphans} removes
 *    files the build didn't touch. Same orphan-free result, no missing-file
 *    window. (Vite mode keeps the clean-before-build path for now.)
 *
 * 2. **Clean is done via Node's `fs.rm`, not a shelled-out `rimraf`.**
 *    See {@link cleanDir} — it handles the Windows transient-error cases
 *    that `rimraf` previously papered over, without dragging `rimraf` into
 *    consumers' install graphs.
 *
 * 3. **`NODE_ENV=production` is passed through `spawn`'s `env` option, not
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

  const distDir = join(targetDir, "dist")
  const before = await snapshotMtimes(distDir)
  const buildCode = await runCommand("tsdown", ["--no-clean"], { env: { NODE_ENV: "production" } })
  if (buildCode !== 0) return buildCode
  await pruneOrphans(distDir, before)
  return 0
}

export async function runDev(): Promise<number> {
  const config = loadConfig()
  return config.buildMode === "vite" ? runCommand("vite", []) : runCommand("tsdown", ["--watch"])
}
