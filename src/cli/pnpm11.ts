import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { List } from "functype"

import type { CheckResult } from "./commands/doctor"
import { targetDir } from "./config"

const HOIST_LINE = /^public-hoist-pattern\[\]=(.+)$/

/**
 * The impure edge of release-age detection: runs a non-mutating pnpm resolution
 * pass and captures its output. Injectable so tests can feed canned pnpm stderr
 * without shelling out. Returns -1 status when pnpm cannot be spawned at all.
 */
export type PnpmReleaseAgeProbe = (dir: string) => { stdout: string; stderr: string; status: number }

// Each per-violation line pnpm prints looks like:
//   left-pad@1.3.0 was published at 2018-04-09T01:10:45.796Z, within the minimumReleaseAge cutoff (...)
// Verified against pnpm 11.5.2: the failure surfaces under the error code
// ERR_PNPM_NO_MATURE_MATCHING_VERSION. We match the per-violation LINE rather than
// the header code so we stay robust to message-format/code changes across pnpm
// releases. The package token is `name@version`, where name may be scoped
// (`@scope/name`).
const RELEASE_AGE_LINE = /(@?[^\s@/]+(?:\/[^\s@]+)?@[^\s]+)\s+was published.*minimumReleaseAge/

/**
 * Pure parser (no I/O): extracts the flagged `pkg@version` tokens from captured
 * pnpm output. Order-preserving and de-duplicated. Returns [] for unrelated or
 * empty output so callers never emit false warnings.
 */
export function parseReleaseAgeViolations(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const line of combined.split("\n")) {
    const m = RELEASE_AGE_LINE.exec(line.trim())
    if (m && !seen.has(m[1])) {
      seen.add(m[1])
      tokens.push(m[1])
    }
  }
  return tokens
}

/** Pure helper: the suggested pnpm-workspace.yaml exclude line for a flagged token. */
export function buildReleaseAgeExcludeLine(pkgVersion: string): string {
  return `minimumReleaseAgeExclude:\n  - "${pkgVersion}"`
}

/**
 * Default probe: runs `pnpm install --resolution-only`, which re-runs resolution
 * (re-applying minimumReleaseAge) and captures its output. If pnpm is not on PATH
 * the spawn errors and we return status -1 so detection degrades quietly.
 *
 * SNAPSHOT/RESTORE: `--resolution-only` is NOT non-mutating in general. When the
 * committed `pnpm-lock.yaml` is stale or doesn't match resolution, pnpm REWRITES
 * it to match (it only avoids writing when it ABORTS on a violation). A read-only
 * diagnostic must never touch a consumer's lockfile, so we snapshot the exact
 * bytes before spawning and restore them in a `finally` — putting the file back
 * exactly as found (or removing one the probe created where none existed).
 * `--resolution-only` does not install packages, so node_modules is not a concern.
 */
export const defaultReleaseAgeProbe: PnpmReleaseAgeProbe = (dir) => {
  const lockPath = join(dir, "pnpm-lock.yaml")
  const lockExisted = existsSync(lockPath)
  // readFileSync without an encoding yields a Buffer, preserving bytes exactly.
  const originalLock = lockExisted ? readFileSync(lockPath) : undefined
  try {
    const result = spawnSync("pnpm", ["install", "--resolution-only"], {
      cwd: dir,
      encoding: "utf-8",
      env: process.env,
    })
    if (result.error) {
      return { stdout: "", stderr: "", status: -1 }
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 }
  } finally {
    if (lockExisted && originalLock !== undefined) {
      writeFileSync(lockPath, originalLock)
    } else if (!lockExisted && existsSync(lockPath)) {
      rmSync(lockPath, { force: true })
    }
  }
}

// ─── B2: allowBuilds / esbuild detection ────────────────────────────────────

/**
 * Curated set of packages whose build scripts are known to be unnecessary under
 * pnpm 11's strictDepBuilds. Extend ONLY after verification — this list drives
 * automatic suggestions; wrong entries generate misleading doctor output.
 *
 * esbuild: binary ships via @esbuild/<platform> optional deps; build script not needed.
 */
const CURATED_ALLOW_BUILDS_FALSE: ReadonlyMap<string, string> = new Map([
  ["esbuild", "binary ships via @esbuild/<platform> optional deps; build script not needed"],
])

/** Presence signal: the package appears as a resolved key in the lockfile. */
const LOCKFILE_PKG_PRESENCE = (name: string): RegExp => new RegExp(`(^|[/'"\\s])${name}@`, "m")

/**
 * Pure parser: returns the set of package names already keyed under the
 * `allowBuilds:` block in a `pnpm-workspace.yaml` string. Uses the same
 * manual line-by-line style as the rest of this file — no yaml library.
 *
 * Stops collecting when it hits the next top-level key (line that starts with
 * a non-whitespace char and ends with `:`).
 */
export function readAllowBuildsKeys(yaml: string): Set<string> {
  const keys = new Set<string>()
  let inBlock = false
  for (const raw of yaml.split("\n")) {
    const line = raw.trimEnd()
    if (!inBlock) {
      if (/^allowBuilds:/.test(line)) {
        inBlock = true
      }
      continue
    }
    // A new top-level key ends the block (non-space start, ends with colon)
    if (/^[^\s#]/.test(line)) {
      break
    }
    // Indented entry: "  <name>: <bool>"
    const m = /^\s{1,}([^\s:]+)\s*:/.exec(line)
    if (m) {
      keys.add(m[1])
    }
  }
  return keys
}

function detectAllowBuildsIssues(dir: string): CheckResult[] {
  const lockPath = join(dir, "pnpm-lock.yaml")
  if (!existsSync(lockPath)) {
    return []
  }
  const lockfile = readFileSync(lockPath, "utf-8")

  const wsPath = join(dir, "pnpm-workspace.yaml")
  const wsContent = existsSync(wsPath) ? readFileSync(wsPath, "utf-8") : ""
  const decided = readAllowBuildsKeys(wsContent)

  const results: CheckResult[] = []
  for (const [pkg, rationale] of CURATED_ALLOW_BUILDS_FALSE) {
    if (decided.has(pkg)) {
      // Already decided (true or false) — nothing to report.
      continue
    }
    if (!LOCKFILE_PKG_PRESENCE(pkg).test(lockfile)) {
      // Not present in the lockfile — not applicable.
      continue
    }
    results.push({
      severity: "warning",
      message:
        `${pkg} has an un-decided build script under pnpm 11 strictDepBuilds — ` +
        `this will hard-error (ERR_PNPM_IGNORED_BUILDS) on install.\n` +
        `      Suggested addition to pnpm-workspace.yaml:\n` +
        `        allowBuilds:\n` +
        `          ${pkg}: false   # ${rationale}`,
    })
  }
  return results
}

function detectReleaseAgeIssues(dir: string, probe: PnpmReleaseAgeProbe): CheckResult[] {
  // Only meaningful where pnpm has something to resolve. A bare tmpdir with no
  // lockfile/manifest context yields nothing to flag; the probe degrades to empty.
  const { stdout, stderr } = probe(dir)
  const violations = parseReleaseAgeViolations(stdout, stderr)
  return violations.map((pkgVersion) => ({
    severity: "warning" as const,
    message:
      `${pkgVersion} is newer than the pnpm minimumReleaseAge cutoff — ` +
      `add to pnpm-workspace.yaml to allow it:\n      ${buildReleaseAgeExcludeLine(pkgVersion)}`,
  }))
}

function readHoistPatterns(npmrc: string): string[] {
  return npmrc
    .split("\n")
    .map((line) => HOIST_LINE.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1])
}

export function detectPnpm11Issues(
  dir: string = targetDir,
  releaseAgeProbe: PnpmReleaseAgeProbe = defaultReleaseAgeProbe,
): List<CheckResult> {
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

  for (const allowBuildsIssue of detectAllowBuildsIssues(dir)) {
    results.push(allowBuildsIssue)
  }

  for (const releaseAgeIssue of detectReleaseAgeIssues(dir, releaseAgeProbe)) {
    results.push(releaseAgeIssue)
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

/**
 * Packages we own and publish frequently; a release-age violation on these is
 * almost always "I just published it" rather than a supply-chain concern, so we
 * exclude by BARE name (all versions). Everything else is pinned to the exact
 * flagged version. Match by NAME only — `ts-builds`, `functype`, `functype-*`.
 */
function isFirstParty(name: string): boolean {
  return name === "ts-builds" || name === "functype" || name.startsWith("functype-")
}

/** Strip the trailing `@version` from a `pkg@version` token, scope-aware. */
function packageNameOf(token: string): string {
  const at = token.lastIndexOf("@")
  // Scoped names start with "@" at position 0; that leading "@" is not a separator.
  return at > 0 ? token.slice(0, at) : token
}

/** The target exclude entry for a flagged token: bare name (first-party) or pinned token. */
function releaseAgeExcludeEntry(token: string): string {
  return isFirstParty(packageNameOf(token)) ? packageNameOf(token) : token
}

/** Render a list entry, quoting pinned `pkg@version` forms, leaving bare names unquoted. */
function renderExcludeEntry(entry: string): string {
  return entry.includes("@") ? `  - "${entry}"` : `  - ${entry}`
}

/**
 * Pure parser: returns the set of entries already listed under
 * `minimumReleaseAgeExclude:`, normalized (quotes stripped). Same manual
 * line-by-line style as readAllowBuildsKeys — stops at the next top-level key.
 */
export function readReleaseAgeExcludeEntries(yaml: string): Set<string> {
  const entries = new Set<string>()
  let inBlock = false
  for (const raw of yaml.split("\n")) {
    const line = raw.trimEnd()
    if (!inBlock) {
      if (/^minimumReleaseAgeExclude:/.test(line)) {
        inBlock = true
      }
      continue
    }
    if (/^[^\s#]/.test(line)) {
      break
    }
    const m = /^\s*-\s*"?([^"]+?)"?\s*$/.exec(line)
    if (m) {
      entries.add(m[1])
    }
  }
  return entries
}

/**
 * Insert YAML list entries (already rendered as `  - x` lines) into an existing
 * top-level block, after its last list item and before the next top-level key.
 * Assumes the block exists; de-dup is the caller's responsibility.
 */
function insertListEntries(yaml: string, blockKey: string, renderedLines: string[]): string {
  if (renderedLines.length === 0) return yaml
  const lines = yaml.split("\n")
  const startRe = new RegExp(`^${blockKey}:`)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return yaml
  // The block runs until the next top-level key (non-space, non-comment start).
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) {
      end = i
      break
    }
  }
  // Insert after the last non-empty line within the block.
  let insertAt = start + 1
  for (let i = start + 1; i < end; i++) {
    if (lines[i].trim() !== "") {
      insertAt = i + 1
    }
  }
  lines.splice(insertAt, 0, ...renderedLines)
  return lines.join("\n")
}

/** Insert `  <key>: <value>` map entries into an existing top-level block. */
function insertMapEntries(yaml: string, blockKey: string, entries: Array<[string, string]>): string {
  return insertListEntries(
    yaml,
    blockKey,
    entries.map(([k, v]) => `  ${k}: ${v}`),
  )
}

function safeWrite(path: string, content: string): boolean {
  try {
    writeFileSync(path, content)
    return true
  } catch {
    return false
  }
}

export function migratePnpm11(
  dir: string = targetDir,
  releaseAgeProbe: PnpmReleaseAgeProbe = defaultReleaseAgeProbe,
): MigrationReport {
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

  // Read pnpm-lock.yaml ONCE, up front — BEFORE block (c)'s probe runs. The probe
  // can rewrite the consumer lockfile (see defaultReleaseAgeProbe), so block (d)
  // below must decide allowBuilds from this snapshot, not a re-read after the probe.
  const lockPath = join(dir, "pnpm-lock.yaml")
  const lockfile = existsSync(lockPath) ? readFileSync(lockPath, "utf-8") : undefined

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

  // (c) minimumReleaseAgeExclude — append/merge flagged release-age violations.
  // Pure additive: only ever ADDS to ws (never strips source), so no deferred
  // sourceMutation is needed — it joins the same single ws write below.
  const { stdout, stderr } = releaseAgeProbe(dir)
  const violations = parseReleaseAgeViolations(stdout, stderr)
  if (violations.length > 0) {
    const existing = readReleaseAgeExcludeEntries(ws)
    const newEntries: string[] = []
    const seen = new Set<string>()
    for (const token of violations) {
      const entry = releaseAgeExcludeEntry(token)
      // A bare first-party name already present suppresses a pinned form too,
      // because readReleaseAgeExcludeEntries stores the normalized entry and
      // releaseAgeExcludeEntry maps first-party tokens to that same bare name.
      if (existing.has(entry) || seen.has(entry)) continue
      seen.add(entry)
      newEntries.push(entry)
    }
    if (newEntries.length > 0) {
      const rendered = newEntries.map(renderExcludeEntry)
      if (hasTopLevelKey(ws, "minimumReleaseAgeExclude")) {
        ws = insertListEntries(ws, "minimumReleaseAgeExclude", rendered)
      } else {
        ws = appendBlock(ws, "minimumReleaseAgeExclude:\n" + rendered.join("\n") + "\n")
      }
      wsChanged = true
      actions.push({
        kind: "migrated",
        message: `Added ${newEntries.length} minimumReleaseAgeExclude entr${newEntries.length === 1 ? "y" : "ies"}`,
      })
    }
  }

  // (d) allowBuilds — write `<pkg>: false` for curated packages present in the
  // lockfile and not already decided. Same additive, single-write discipline.
  // Uses the lockfile snapshot read at the top (before block c's probe ran), so
  // it is unaffected by any probe-time lockfile rewrite.
  if (lockfile !== undefined) {
    const decided = readAllowBuildsKeys(ws)
    const toAdd: Array<[string, string]> = []
    for (const pkg of CURATED_ALLOW_BUILDS_FALSE.keys()) {
      if (decided.has(pkg)) continue
      if (!LOCKFILE_PKG_PRESENCE(pkg).test(lockfile)) continue
      toAdd.push([pkg, "false"])
    }
    if (toAdd.length > 0) {
      if (hasTopLevelKey(ws, "allowBuilds")) {
        ws = insertMapEntries(ws, "allowBuilds", toAdd)
      } else {
        ws = appendBlock(ws, "allowBuilds:\n" + toAdd.map(([k, v]) => `  ${k}: ${v}`).join("\n") + "\n")
      }
      wsChanged = true
      actions.push({
        kind: "migrated",
        message: `Added ${toAdd.length} allowBuilds entr${toAdd.length === 1 ? "y" : "ies"}`,
      })
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
