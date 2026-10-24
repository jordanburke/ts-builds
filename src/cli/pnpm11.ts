import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"

import { List, Map, Option, Set, Try } from "functype"

import type { CheckResult } from "./commands/doctor"
import { targetDir } from "./config"

const HOIST_LINE = /^public-hoist-pattern\[\]=(.+)$/

/**
 * The impure edge of release-age detection: runs a pnpm resolution pass, leaving
 * the consumer's files as it found them, and captures its output. Injectable so
 * tests can feed canned pnpm output without shelling out. Returns -1 status when
 * pnpm cannot be spawned at all.
 */
export type PnpmReleaseAgeProbe = (dir: string) => PnpmProbeResult

export type PnpmProbeResult = {
  stdout: string
  stderr: string
  status: number
  /**
   * `minimumReleaseAgeExclude` entries pnpm added to a `pnpm-workspace.yaml` during
   * the run (lenient mode). pnpm 12 run from a workspace package writes them without
   * printing anything about it, so the file is the only reliable signal.
   */
  autoExcluded?: string[]
}

// A package token is `name@version`, where name may be scoped (`@scope/name`).
const PKG_VERSION = String.raw`@?[^\s@/]+(?:\/[^\s@]+)?@\S+`

// pnpm reports release-age violations in one of two shapes, depending on
// `minimumReleaseAgeStrict`. Both verified against pnpm 11.27.0 and 12.15.0.
//
// Strict: the install fails (ERR_PNPM_NO_MATURE_MATCHING_VERSION) and lists each violation:
//   left-pad@1.3.0 was published at 2018-04-09T01:10:45.796Z, within the minimumReleaseAge cutoff (...)
// A too-new version already pinned in the lockfile fails pnpm's lockfile verification
// (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION) with the same per-entry wording, in either mode.
// pnpm 11 prints these on one line to stdout. pnpm 12 prints them to stderr wrapped at
// 80 columns (it ignores COLUMNS), and it breaks after hyphens as well as at spaces, so
// a date or a package name can be split mid-token ("2026-10-\n      24T13:21:38.101Z").
// The output is therefore matched with hyphen breaks rejoined and the remaining
// whitespace collapsed. We match the per-violation wording rather than the
// error code so we stay robust to code changes across pnpm releases. The match is kept
// tight ("was published [at <time>,] within the minimumReleaseAge") because, on
// collapsed text, a loose `.*?` could pair an unrelated "was published" with a later,
// unrelated mention of minimumReleaseAge.
const RELEASE_AGE_VIOLATION = new RegExp(
  `(${PKG_VERSION}) was published (?:at \\S+, )?within the minimumReleaseAge`,
  "g",
)

// Lenient (the default): the install succeeds, pnpm writes the entries into
// pnpm-workspace.yaml itself, and lists them under a header:
//   Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict ...):
//     tsdown@0.23.2
const AUTO_EXCLUDE_HEADER = /^Added \d+ entr\S* to minimumReleaseAgeExclude/
const AUTO_EXCLUDE_ENTRY = new RegExp(`^\\s+(${PKG_VERSION})$`)

/**
 * Pure parser (no I/O): extracts the flagged `pkg@version` tokens from captured
 * pnpm output, in either the strict or the lenient shape. Order-preserving and
 * de-duplicated. Returns [] for unrelated or empty output so callers never emit
 * false warnings.
 */
export function parseReleaseAgeViolations(stdout: string, stderr: string): string[] {
  const output = `${stdout}\n${stderr}`
  const unwrapped = output.replace(/-\r?\n\s+/g, "-").replace(/\s+/g, " ")
  const strict = [...unwrapped.matchAll(RELEASE_AGE_VIOLATION)].map((match) => match[1])
  return List([...strict, ...autoExcludedEntries(output)])
    .distinct()
    .toArray()
}

/** The `pkg@version` lines listed under pnpm's lenient-mode "Added N entries" header. */
function autoExcludedEntries(output: string): string[] {
  const lines = output.split("\n").map((raw) => raw.trimEnd())
  const start = lines.findIndex((line) => AUTO_EXCLUDE_HEADER.test(line.trim()))
  if (start === -1) return []
  const body = lines.slice(start + 1)
  const end = body.findIndex((line) => !AUTO_EXCLUDE_ENTRY.test(line))
  return matchFirstGroups(end === -1 ? body : body.slice(0, end), AUTO_EXCLUDE_ENTRY)
}

/** Pure helper: the suggested pnpm-workspace.yaml exclude line for a flagged token. */
export function buildReleaseAgeExcludeLine(pkgVersion: string): string {
  return `minimumReleaseAgeExclude:\n${renderExcludeEntry(releaseAgeExcludeEntry(pkgVersion))}`
}

/** The command the default probe runs. Exported so warnings and tests name it exactly. */
export const RELEASE_AGE_PROBE_ARGS = ["install", "--lockfile-only"] as const

/**
 * Default probe: runs `pnpm install --lockfile-only`, which resolves anything the
 * lockfile does not already pin (re-applying minimumReleaseAge) without installing
 * packages, and captures its output. `--lockfile-only` exists in pnpm 11 and 12;
 * the `--resolution-only` flag this used before was removed in pnpm 12. If pnpm is
 * not on PATH the spawn errors and we return status -1 so detection degrades quietly.
 *
 * SNAPSHOT/RESTORE: the run is NOT non-mutating. pnpm rewrites `pnpm-lock.yaml`
 * to match resolution, and in lenient mode it also writes the violating packages
 * into `pnpm-workspace.yaml` itself. A read-only diagnostic must never touch a
 * consumer's files, so we snapshot the exact bytes of both files — in `dir` and at
 * the workspace root pnpm resolves from — and restore them in a `finally`, putting
 * each back exactly as found (or removing one the probe created where none existed).
 */
export const defaultReleaseAgeProbe: PnpmReleaseAgeProbe = (dir) => {
  const snapshots = probeWrittenFiles(dir).map(snapshotFile)
  try {
    const result = spawnSync("pnpm", [...RELEASE_AGE_PROBE_ARGS], {
      cwd: dir,
      encoding: "utf-8",
      env: process.env,
    })
    if (result.error) {
      return { stdout: "", stderr: "", status: -1 }
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 1,
      // Read before the `finally` restores the files.
      autoExcluded: snapshots.flatMap(addedExcludeEntries),
    }
  } finally {
    snapshots.forEach(restoreFile)
  }
}

type FileSnapshot = { path: string; bytes: Option<Buffer> }

/** The `minimumReleaseAgeExclude` entries a `pnpm-workspace.yaml` gained since its snapshot. */
function addedExcludeEntries({ path, bytes }: FileSnapshot): string[] {
  if (basename(path) !== "pnpm-workspace.yaml" || !isFile(path)) return []
  const before = readReleaseAgeExcludeEntries(
    bytes.fold(
      () => "",
      (original) => original.toString("utf-8"),
    ),
  )
  return readReleaseAgeExcludeEntries(readFileSync(path, "utf-8"))
    .toArray()
    .filter((entry) => !before.has(entry))
}

/**
 * `pnpm-lock.yaml` and `pnpm-workspace.yaml` in `dir` and at its workspace root,
 * if it has one. A path that exists but is not a regular file is left untracked,
 * since pnpm cannot have written it either.
 */
function probeWrittenFiles(dir: string): string[] {
  const roots = findWorkspaceRoot(dir).fold(
    () => [dir],
    (root) => [dir, root],
  )
  return List(roots)
    .distinct()
    .toArray()
    .flatMap((root) => [join(root, "pnpm-lock.yaml"), join(root, "pnpm-workspace.yaml")])
    .filter((path) => !existsSync(path) || isFile(path))
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()

/** The nearest directory at or above `dir` holding a `pnpm-workspace.yaml`. */
function findWorkspaceRoot(dir: string): Option<string> {
  if (isFile(join(dir, "pnpm-workspace.yaml"))) return Option(dir)
  const parent = dirname(dir)
  return parent === dir ? Option.none<string>() : findWorkspaceRoot(parent)
}

// ─── Stray pnpm-workspace.yaml inside a workspace package (#210) ────────────

/** The `packages:` globs of a `pnpm-workspace.yaml`, quotes stripped. */
export function readWorkspacePackageGlobs(yaml: string): string[] {
  return readListBlock(yaml, /^packages:/)
}

// One glob token: `**/`, a trailing `/**`, `**`, `*`, `?`, or any other single character.
const GLOB_TOKEN = /\*\*\/|\/\*\*$|\*\*|\*|\?|[^*?]/g
const GLOB_TOKEN_REGEX: Record<string, string> = {
  "**/": "(?:.*/)?",
  "/**": "(?:/.*)?",
  "**": ".*",
  "*": "[^/]*",
  "?": "[^/]",
}

const normalizeGlobPath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")

function globRegExp(glob: string): RegExp {
  const body = normalizeGlobPath(glob).replace(
    GLOB_TOKEN,
    (token) => GLOB_TOKEN_REGEX[token] ?? token.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
  )
  return new RegExp(`^${body}$`)
}

/**
 * Pure matcher: whether pnpm's `packages:` globs list `relDir`, a directory path
 * relative to the workspace root. Covers the forms pnpm documents: `*` (within one
 * path segment), `**` (any depth, including none), `?`, and a leading `!` to exclude.
 * Listed means some include matches and no exclude does.
 */
export function isListedPackage(relDir: string, globs: string[]): boolean {
  const path = normalizeGlobPath(relDir)
  const matches = (glob: string): boolean => globRegExp(glob).test(path)
  const includes = globs.filter((glob) => !glob.startsWith("!"))
  const excludes = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1))
  return includes.some(matches) && !excludes.some(matches)
}

/** The workspace root strictly above `dir` whose `packages:` globs list it, if any. */
function findListingRoot(dir: string): Option<string> {
  const parent = dirname(dir)
  if (parent === dir) return Option.none<string>()
  return findWorkspaceRoot(parent).filter((root) =>
    isListedPackage(
      relative(root, dir),
      readWorkspacePackageGlobs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8")),
    ),
  )
}

/**
 * For a package with its own `pnpm-workspace.yaml` that a workspace root above
 * lists, that root. pnpm treats only a directory with a `package.json` as a
 * workspace package, and a nested file in an unlisted directory is a legitimate
 * separate workspace (pnpm 12 creates one there itself), so both are required.
 */
function strayWorkspaceRoot(dir: string): Option<string> {
  const ownFile = isFile(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "package.json"))
  return ownFile ? findListingRoot(dir) : Option.none<string>()
}

/**
 * Directories below `dir` holding their own `pnpm-workspace.yaml`, without
 * descending into one once found. Skips hidden directories, `node_modules` and
 * symlinks, like the lint-report walk; an unreadable directory counts as empty.
 */
function nestedWorkspaceDirs(dir: string): string[] {
  const entries = Try(() => readdirSync(dir, { withFileTypes: true })).orElse([])
  const subdirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => join(dir, entry.name))
  return subdirs.flatMap((sub) => (isFile(join(sub, "pnpm-workspace.yaml")) ? [sub] : nestedWorkspaceDirs(sub)))
}

/**
 * Every stray file `doctor` should report from `dir`: `dir` itself when it is a
 * stray package, and, when `dir` is a workspace root, each package below it that
 * its globs list and that has its own `pnpm-workspace.yaml`. Returned as
 * `[root, packageDir]` pairs.
 */
function findStrayWorkspaceFiles(dir: string): Array<[string, string]> {
  const asPackage = strayWorkspaceRoot(dir).fold(
    (): Array<[string, string]> => [],
    (root) => [[root, dir]],
  )
  const wsPath = join(dir, "pnpm-workspace.yaml")
  const globs = isFile(wsPath) ? readWorkspacePackageGlobs(readFileSync(wsPath, "utf-8")) : []
  // No `packages:` key means a single-project workspace: nothing below it is listed.
  const asRoot =
    globs.length === 0
      ? []
      : nestedWorkspaceDirs(dir)
          .filter((sub) => existsSync(join(sub, "package.json")) && isListedPackage(relative(dir, sub), globs))
          .map((sub): [string, string] => [dir, sub])
  return [...asPackage, ...asRoot]
}

function detectStrayWorkspaceFiles(dir: string): CheckResult[] {
  return findStrayWorkspaceFiles(dir).map(([root, pkgDir]) => {
    const rel = relative(root, pkgDir).split(sep).join("/")
    return {
      severity: "warning" as const,
      message:
        `${rel}/pnpm-workspace.yaml sits inside a package that the workspace root (${root}) lists. ` +
        `Its settings don't apply to the workspace, and pnpm run from ${rel} treats it as a separate ` +
        `workspace: it ignores the root's settings and packageManager pin and writes its own ` +
        `pnpm-lock.yaml. Move any settings it holds to the root's pnpm-workspace.yaml and delete it, ` +
        `or add "!${rel}" to the root's packages to keep it a separate workspace`,
    }
  })
}

function snapshotFile(path: string): FileSnapshot {
  // readFileSync without an encoding yields a Buffer, preserving bytes exactly.
  return { path, bytes: existsSync(path) ? Option(readFileSync(path)) : Option.none<Buffer>() }
}

function restoreFile({ path, bytes }: FileSnapshot): void {
  bytes.fold(
    () => {
      if (existsSync(path)) rmSync(path, { force: true })
    },
    (original) => writeFileSync(path, original),
  )
}

// ─── B2: allowBuilds / esbuild detection ────────────────────────────────────

/**
 * Curated set of packages whose build scripts are known to be unnecessary under
 * pnpm 11's strictDepBuilds. Extend ONLY after verification — this list drives
 * automatic suggestions; wrong entries generate misleading doctor output.
 *
 * esbuild: binary ships via @esbuild/<platform> optional deps; build script not needed.
 */
const CURATED_ALLOW_BUILDS_FALSE: Map<string, string> = Map([
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
  // Indented entry: "  <name>: <bool>"
  return Set(matchFirstGroups(blockLines(yaml, /^allowBuilds:/), /^\s{1,}([^\s:]+)\s*:/))
}

/**
 * The lines of the top-level block whose header matches `header`, each trimmed at
 * the end, up to the next top-level key (a line starting with neither whitespace
 * nor `#`). Returns [] when the block is absent.
 */
function blockLines(yaml: string, header: RegExp): string[] {
  const lines = yaml.split("\n").map((raw) => raw.trimEnd())
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) return []
  const body = lines.slice(start + 1)
  const end = body.findIndex((line) => /^[^\s#]/.test(line))
  return end === -1 ? body : body.slice(0, end)
}

/** The first capture group of `pattern` for every line it matches. */
function matchFirstGroups(lines: string[], pattern: RegExp): string[] {
  return lines.map((line) => pattern.exec(line)?.[1]).filter((group): group is string => group !== undefined)
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

  // Skip packages already decided (true or false) and packages absent from the lockfile.
  return [...CURATED_ALLOW_BUILDS_FALSE]
    .filter(([pkg]) => !decided.has(pkg) && LOCKFILE_PKG_PRESENCE(pkg).test(lockfile))
    .map(([pkg, rationale]) => ({
      severity: "warning" as const,
      message:
        `${pkg} has an un-decided build script under pnpm 11 strictDepBuilds — ` +
        `this will hard-error (ERR_PNPM_IGNORED_BUILDS) on install.\n` +
        `      Suggested addition to pnpm-workspace.yaml:\n` +
        `        allowBuilds:\n` +
        `          ${pkg}: false   # ${rationale}`,
    }))
}

function detectReleaseAgeIssues(dir: string, probe: PnpmReleaseAgeProbe): CheckResult[] {
  const result = probe(dir)
  const { stdout, stderr, status } = result
  const violations = probeViolations(result)
  if (violations.length > 0) {
    return violations.map((pkgVersion) => ({
      severity: "warning" as const,
      message:
        `${pkgVersion} is newer than the pnpm minimumReleaseAge cutoff — ` +
        `add to pnpm-workspace.yaml to allow it:\n      ${buildReleaseAgeExcludeLine(pkgVersion)}`,
    }))
  }
  return probeFailure(stdout, stderr, status)
    .map((message): CheckResult[] => [{ severity: "warning", message }])
    .orElse([])
}

/** Every flagged `pkg@version`, from pnpm's output and from the entries it wrote. */
function probeViolations({ stdout, stderr, autoExcluded = [] }: PnpmProbeResult): string[] {
  return List([...parseReleaseAgeViolations(stdout, stderr), ...autoExcluded])
    .distinct()
    .toArray()
}

/**
 * A message when the probe ran pnpm and pnpm failed without reporting a violation,
 * meaning the release-age check never actually ran. That must not read as "ready".
 * Status -1 (pnpm not installed) stays quiet: there is nothing to check against.
 */
function probeFailure(stdout: string, stderr: string, status: number): Option<string> {
  if (status <= 0) return Option.none<string>()
  // pnpm 11 prints errors to stdout (after a "Scope:" line in a workspace), pnpm 12
  // to stderr. Prefer the line naming the pnpm error code.
  const lines = `${stderr}\n${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const reason = lines.find((line) => line.includes("ERR_PNPM")) ?? lines.at(0)
  const command = `pnpm ${RELEASE_AGE_PROBE_ARGS.join(" ")}`
  const detail = reason === undefined ? "" : `: ${reason}`
  return Option(`Could not check minimumReleaseAge: \`${command}\` exited ${status}${detail}`)
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
  const npmrcPath = join(dir, ".npmrc")
  const npmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf-8") : ""
  const hoistCount = readHoistPatterns(npmrc).length
  const hoistIssues: CheckResult[] =
    hoistCount > 0
      ? [
          {
            severity: "warning",
            message: `${hoistCount} hoist pattern(s) in .npmrc are ignored by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml`,
          },
        ]
      : []

  const pnpmFieldIssues: CheckResult[] = hasPnpmField(join(dir, "package.json"))
    ? [
        {
          severity: "warning",
          message: `package.json 'pnpm' field is no longer read by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml`,
        },
      ]
    : []

  const results = [
    ...hoistIssues,
    ...pnpmFieldIssues,
    ...detectAllowBuildsIssues(dir),
    ...detectReleaseAgeIssues(dir, releaseAgeProbe),
    ...detectStrayWorkspaceFiles(dir),
  ]

  return List(results.length > 0 ? results : [{ severity: "info", message: "pnpm 11 ready" }])
}

function hasPnpmField(pkgPath: string): boolean {
  if (!existsSync(pkgPath)) return false
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pnpm?: Record<string, unknown> }
  return Boolean(pkg.pnpm && typeof pkg.pnpm === "object" && Object.keys(pkg.pnpm).length > 0)
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
const KNOWN_PNPM_KEYS = Set.of("overrides", "peerDependencyRules")

function hasTopLevelKey(yaml: string, key: string): boolean {
  return new RegExp(`^${key}:`, "m").test(yaml)
}

function appendBlock(existing: string, block: string): string {
  if (existing.length === 0) return block
  const base = existing.endsWith("\n") ? existing : `${existing}\n`
  return `${base}\n${block}`
}

function renderPublicHoistPattern(patterns: string[]): string {
  return `publicHoistPattern:\n${patterns.map((p) => `  - "${p}"`).join("\n")}\n`
}

function renderOverrides(overrides: Record<string, string>): string {
  return `overrides:\n${Object.entries(overrides)
    .map(([k, v]) => `  "${k}": "${v}"`)
    .join("\n")}\n`
}

function renderPeerDependencyRules(rules: NonNullable<PnpmField["peerDependencyRules"]>): string {
  const allowedVersions = Object.entries(rules.allowedVersions ?? {})
  const ignoreMissing = rules.ignoreMissing ?? []
  const lines = [
    "peerDependencyRules:",
    ...(allowedVersions.length > 0
      ? ["  allowedVersions:", ...allowedVersions.map(([k, v]) => `    "${k}": "${v}"`)]
      : []),
    ...(ignoreMissing.length > 0 ? ["  ignoreMissing:", ...ignoreMissing.map((name) => `    - "${name}"`)] : []),
  ]
  return `${lines.join("\n")}\n`
}

/**
 * First-party packages we publish ourselves — a release-age violation on these is
 * almost always "I just published it" rather than a supply-chain concern, so we
 * exclude them at ALL versions instead of pinning (pins re-trip on every release).
 *
 * The functype family is open-ended (functype, functype-os, eslint-config-functype,
 * eslint-plugin-functype, and future functype-*), so it collapses to a single
 * `*functype*` name glob. `ts-builds` is a lone package excluded by bare name.
 */
const FIRST_PARTY_FUNCTYPE_GLOB = "*functype*"

function isFirstPartyFunctype(name: string): boolean {
  return name.includes("functype")
}

/** Strip the trailing `@version` from a `pkg@version` token, scope-aware. */
function packageNameOf(token: string): string {
  const at = token.lastIndexOf("@")
  // Scoped names start with "@" at position 0; that leading "@" is not a separator.
  return at > 0 ? token.slice(0, at) : token
}

/**
 * Canonical exclude entry for a flagged `pkg@version` token — or for an existing
 * entry being re-checked. First-party functype family → the `*functype*` glob,
 * `ts-builds` → bare `ts-builds`, an entry that is already a glob/pattern is left
 * untouched, and everything else (third-party) stays pinned to its exact version.
 */
function releaseAgeExcludeEntry(entry: string): string {
  if (entry.includes("*")) return entry
  const name = packageNameOf(entry)
  if (isFirstPartyFunctype(name)) return FIRST_PARTY_FUNCTYPE_GLOB
  if (name === "ts-builds") return "ts-builds"
  return entry
}

/**
 * Render a list entry. Quote pinned (`@`), scoped, or glob (`*`) forms — a bare
 * `*functype*` would otherwise be parsed as a YAML alias. Plain names stay unquoted.
 */
function renderExcludeEntry(entry: string): string {
  return /[@*]/.test(entry) ? `  - "${entry}"` : `  - ${entry}`
}

/**
 * Pure parser: returns the set of entries already listed under
 * `minimumReleaseAgeExclude:`, normalized (quotes stripped). pnpm itself writes
 * scoped entries single-quoted (`- '@scope/name@1.0.0'`); we write them
 * double-quoted. Same manual line-by-line style as readAllowBuildsKeys — stops at
 * the next top-level key.
 */
export function readReleaseAgeExcludeEntries(yaml: string): Set<string> {
  return Set(readListBlock(yaml, /^minimumReleaseAgeExclude:/))
}

// A YAML list item: `- entry`, `- 'entry'` or `- "entry"`, optionally followed by a `# comment`.
const YAML_LIST_ENTRY = /^\s*-\s*(["']?)([^"'\s#]+)\1\s*(?:#.*)?$/

/** The unquoted items of the top-level list block whose header matches `header`. */
function readListBlock(yaml: string, header: RegExp): string[] {
  return blockLines(yaml, header)
    .map((line) => YAML_LIST_ENTRY.exec(line)?.[2])
    .filter((entry): entry is string => entry !== undefined)
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
  const start = lines.findIndex((line) => startRe.test(line))
  if (start === -1) return yaml
  // The block runs until the next top-level key (non-space, non-comment start).
  const afterStart = lines.slice(start + 1)
  const nextKey = afterStart.findIndex((line) => /^[^\s#]/.test(line))
  const block = nextKey === -1 ? afterStart : afterStart.slice(0, nextKey)
  // Insert after the last non-empty line within the block.
  const insertAt = start + 1 + block.findLastIndex((line) => line.trim() !== "") + 1
  return [...lines.slice(0, insertAt), ...renderedLines, ...lines.slice(insertAt)].join("\n")
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

/** The result of one source-file edit, run after pnpm-workspace.yaml is safely written. */
type SourceMutation = () => MigrationReport

/** One migration step: the workspace YAML it leaves, what it did, and the source edits it defers. */
type MigrationStep = {
  ws: string
  actions: MigrationAction[]
  sourceMutations: SourceMutation[]
}

const noChange = (ws: string): MigrationStep => ({ ws, actions: [], sourceMutations: [] })

function combineReports(reports: MigrationReport[]): MigrationReport {
  return {
    actions: reports.flatMap((r) => r.actions),
    errors: reports.reduce((sum, r) => sum + r.errors, 0),
  }
}

/** (a) .npmrc hoist patterns -> pnpm-workspace.yaml */
function migrateNpmrcHoist(dir: string, ws: string): MigrationStep {
  const npmrcPath = join(dir, ".npmrc")
  if (!existsSync(npmrcPath)) return noChange(ws)
  const npmrc = readFileSync(npmrcPath, "utf-8")
  const patterns = readHoistPatterns(npmrc)
  if (patterns.length === 0) return noChange(ws)

  if (hasTopLevelKey(ws, "publicHoistPattern")) {
    return {
      ws,
      actions: [
        {
          kind: "skipped",
          message: "publicHoistPattern already in pnpm-workspace.yaml — left .npmrc lines for manual review",
        },
      ],
      sourceMutations: [],
    }
  }

  const remaining = npmrc
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      return !HOIST_LINE.test(t) && t !== NPMRC_HEADER
    })
    .join("\n")

  const rewriteNpmrc: SourceMutation = () => {
    if (remaining.trim() === "") {
      try {
        rmSync(npmrcPath)
        return { actions: [{ kind: "removed", message: "Removed empty .npmrc" }], errors: 0 }
      } catch {
        return {
          actions: [{ kind: "manual", message: "Could not remove .npmrc — delete the migrated hoist lines manually" }],
          errors: 1,
        }
      }
    }
    if (!safeWrite(npmrcPath, remaining.endsWith("\n") ? remaining : `${remaining}\n`)) {
      return {
        actions: [{ kind: "manual", message: "Could not rewrite .npmrc — delete the migrated hoist lines manually" }],
        errors: 1,
      }
    }
    return { actions: [], errors: 0 }
  }

  return {
    ws: appendBlock(ws, renderPublicHoistPattern(patterns)),
    actions: [{ kind: "migrated", message: `Migrated ${patterns.length} hoist pattern(s) to pnpm-workspace.yaml` }],
    sourceMutations: [rewriteNpmrc],
  }
}

/** Move one known `pnpm` field key into the workspace YAML, unless the YAML already has it. */
function migratePnpmKey<T extends object>(
  ws: string,
  key: "overrides" | "peerDependencyRules",
  value: T | undefined,
  render: (value: T) => string,
): { ws: string; actions: MigrationAction[]; migrated: boolean } {
  if (!value || Object.keys(value).length === 0) return { ws, actions: [], migrated: false }
  if (hasTopLevelKey(ws, key)) {
    return {
      ws,
      actions: [{ kind: "skipped", message: `${key} already in pnpm-workspace.yaml — reconcile manually` }],
      migrated: false,
    }
  }
  return {
    ws: appendBlock(ws, render(value)),
    actions: [{ kind: "migrated", message: `Migrated pnpm.${key}` }],
    migrated: true,
  }
}

/** (b) package.json pnpm field -> pnpm-workspace.yaml */
function migratePackageJsonPnpm(dir: string, ws: string): MigrationStep {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return noChange(ws)
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pnpm?: PnpmField; [k: string]: unknown }
  const { pnpm } = pkg
  if (!pnpm || typeof pnpm !== "object") return noChange(ws)

  const overrides = migratePnpmKey(ws, "overrides", pnpm.overrides, renderOverrides)
  const peerRules = migratePnpmKey(
    overrides.ws,
    "peerDependencyRules",
    pnpm.peerDependencyRules,
    renderPeerDependencyRules,
  )
  const migratedKeys = Set([
    ...(overrides.migrated ? ["overrides"] : []),
    ...(peerRules.migrated ? ["peerDependencyRules"] : []),
  ])

  const remainingPnpm = Object.fromEntries(Object.entries(pnpm).filter(([key]) => !migratedKeys.has(key)))
  const manual: MigrationAction[] = Object.keys(remainingPnpm)
    .filter((key) => !KNOWN_PNPM_KEYS.has(key))
    .map((key) => ({ kind: "manual", message: `pnpm.${key} needs manual migration (left in package.json)` }))

  const pnpmEmptied = Object.keys(remainingPnpm).length === 0
  const nextPkg = pnpmEmptied
    ? Object.fromEntries(Object.entries(pkg).filter(([key]) => key !== "pnpm"))
    : { ...pkg, pnpm: remainingPnpm }

  const rewritePackageJson: SourceMutation = () =>
    safeWrite(pkgPath, `${JSON.stringify(nextPkg, null, 2)}\n`)
      ? { actions: [], errors: 0 }
      : {
          actions: [
            {
              kind: "manual",
              message: "Could not rewrite package.json — remove the migrated pnpm field keys manually",
            },
          ],
          errors: 1,
        }

  return {
    ws: peerRules.ws,
    actions: [...overrides.actions, ...peerRules.actions, ...manual],
    sourceMutations: !migratedKeys.isEmpty || pnpmEmptied ? [rewritePackageJson] : [],
  }
}

/**
 * (c) minimumReleaseAgeExclude — append/merge flagged release-age violations.
 * Pure additive: only ever ADDS to ws (never strips source), so no deferred
 * sourceMutation is needed — it joins the same single ws write.
 */
function migrateReleaseAgeExcludes(dir: string, ws: string, probe: PnpmReleaseAgeProbe): MigrationStep {
  const result = probe(dir)
  const { stdout, stderr, status } = result
  const violations = probeViolations(result)
  if (violations.length === 0) {
    return probeFailure(stdout, stderr, status).fold(
      () => noChange(ws),
      (message) => ({ ws, actions: [{ kind: "skipped" as const, message }], sourceMutations: [] }),
    )
  }
  // Canonicalize existing entries so any first-party form already present —
  // a `functype@x` pin pnpm auto-added, a bare `functype-os`, or the `*functype*`
  // glob itself — counts as covering a fresh functype-family violation, and we
  // never pile on a redundant glob. Additive only: existing entries are read,
  // never rewritten.
  const covered = readReleaseAgeExcludeEntries(ws).map(releaseAgeExcludeEntry)
  const newEntries = List(violations.map(releaseAgeExcludeEntry))
    .filter((entry) => !covered.has(entry))
    .distinct()
    .toArray()
  if (newEntries.length === 0) return noChange(ws)

  const rendered = newEntries.map(renderExcludeEntry)
  return {
    ws: hasTopLevelKey(ws, "minimumReleaseAgeExclude")
      ? insertListEntries(ws, "minimumReleaseAgeExclude", rendered)
      : appendBlock(ws, `minimumReleaseAgeExclude:\n${rendered.join("\n")}\n`),
    actions: [
      {
        kind: "migrated",
        message: `Added ${newEntries.length} minimumReleaseAgeExclude entr${newEntries.length === 1 ? "y" : "ies"}`,
      },
    ],
    sourceMutations: [],
  }
}

/**
 * (d) allowBuilds — write `<pkg>: false` for curated packages present in the
 * lockfile and not already decided. Same additive, single-write discipline.
 */
function migrateAllowBuilds(ws: string, lockfile: string | undefined): MigrationStep {
  if (lockfile === undefined) return noChange(ws)
  const decided = readAllowBuildsKeys(ws)
  const toAdd: Array<[string, string]> = [...CURATED_ALLOW_BUILDS_FALSE]
    .map(([pkg]) => pkg)
    .filter((pkg) => !decided.has(pkg) && LOCKFILE_PKG_PRESENCE(pkg).test(lockfile))
    .map((pkg) => [pkg, "false"])
  if (toAdd.length === 0) return noChange(ws)

  return {
    ws: hasTopLevelKey(ws, "allowBuilds")
      ? insertMapEntries(ws, "allowBuilds", toAdd)
      : appendBlock(ws, `allowBuilds:\n${toAdd.map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`),
    actions: [
      { kind: "migrated", message: `Added ${toAdd.length} allowBuilds entr${toAdd.length === 1 ? "y" : "ies"}` },
    ],
    sourceMutations: [],
  }
}

/**
 * The refusal `--fix` reports from inside a workspace package. pnpm reads
 * pnpm-workspace.yaml settings only from the workspace root: writing them into the
 * package's own file would do nothing, and a stray pnpm-workspace.yaml can make pnpm
 * treat the package as its own workspace root. Moving the package's settings to the
 * root is not automated, because it could switch on settings that are inert today
 * (a package's `pnpm.overrides`, say).
 */
function workspacePackageAction(root: string): MigrationAction {
  return {
    kind: "manual",
    message:
      `Nothing changed: this is a workspace package, and pnpm reads these settings only from the ` +
      `workspace root (${root}). Run 'ts-builds doctor --fix' there, and move any settings in this ` +
      `package's .npmrc or package.json "pnpm" field to the root's pnpm-workspace.yaml by hand`,
  }
}

/**
 * The refusal `--fix` reports from a stray package: one with its own
 * `pnpm-workspace.yaml` that a workspace root lists. pnpm run from here does read
 * that file, which is the problem, so writing more into it would entrench it.
 */
function strayPackageAction(root: string): MigrationAction {
  return {
    kind: "manual",
    message:
      `Nothing changed: this package's own pnpm-workspace.yaml sits inside the workspace rooted at ` +
      `${root} (see the warning above). Move its settings to the root's pnpm-workspace.yaml and ` +
      `delete it, then run 'ts-builds doctor --fix' from the root`,
  }
}

/** Why `--fix` must not write from `dir`, if it must not: a stray or ordinary workspace package. */
function workspaceRefusal(dir: string): Option<MigrationAction> {
  const stray = strayWorkspaceRoot(dir).map(strayPackageAction)
  if (stray.isSome()) return stray
  return findWorkspaceRoot(dir)
    .filter((root) => root !== dir)
    .map(workspacePackageAction)
}

export function migratePnpm11(
  dir: string = targetDir,
  releaseAgeProbe: PnpmReleaseAgeProbe = defaultReleaseAgeProbe,
): MigrationReport {
  const wsPath = join(dir, "pnpm-workspace.yaml")
  const wsExists = existsSync(wsPath) && statSync(wsPath).isFile()
  const originalWs = wsExists ? readFileSync(wsPath, "utf-8") : ""

  // Read pnpm-lock.yaml ONCE, up front — BEFORE step (c)'s probe runs. pnpm
  // rewrites the lockfile during the probe; the default probe restores it, but an
  // injected one need not, so step (d) decides allowBuilds from this snapshot.
  const lockPath = join(dir, "pnpm-lock.yaml")
  const lockfile = existsSync(lockPath) ? readFileSync(lockPath, "utf-8") : undefined

  // Each step only ever appends to ws, so "ws changed" is exactly "ws differs".
  const npmrc = migrateNpmrcHoist(dir, originalWs)
  const pkgJson = migratePackageJsonPnpm(dir, npmrc.ws)
  const releaseAge = migrateReleaseAgeExcludes(dir, pkgJson.ws, releaseAgeProbe)
  const allowBuilds = migrateAllowBuilds(releaseAge.ws, lockfile)
  const steps = [npmrc, pkgJson, releaseAge, allowBuilds]
  const { ws } = allowBuilds
  const actions = steps.flatMap((step) => step.actions)

  // Every step above is computed without writing, so a workspace package can be
  // refused here with nothing touched. Only a pending write is refused: steps that
  // write nothing (a skipped probe, a key left for manual migration) report as usual.
  const wouldWrite = ws !== originalWs || steps.some((step) => step.sourceMutations.length > 0)
  const refusal = wouldWrite ? workspaceRefusal(dir) : Option.none<MigrationAction>()
  if (refusal.isSome()) return { actions: [refusal.orThrow()], errors: 0 }

  // Destructive edits to the SOURCE files are deferred until the destination
  // (pnpm-workspace.yaml) is safely on disk — otherwise a failed ws write would
  // lose config that was already stripped from .npmrc / package.json.
  if (ws !== originalWs && !safeWrite(wsPath, ws)) {
    return {
      actions: [
        ...actions,
        {
          kind: "manual",
          message: "Could not write pnpm-workspace.yaml — no changes made to .npmrc or package.json",
        },
      ],
      errors: 1,
    }
  }

  const applied = combineReports(steps.flatMap((step) => step.sourceMutations).map((mutate) => mutate()))
  return { actions: [...actions, ...applied.actions], errors: applied.errors }
}
