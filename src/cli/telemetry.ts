import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

import type { ESLint } from "eslint"
import { Option, Try } from "functype"

/**
 * Opt-in lint telemetry: per-rule counts from a `ts-builds lint` run, sent to an endpoint you
 * choose so you can see which rules fire, which get silenced, and whether that changes over time.
 *
 * Off unless `TS_BUILDS_TELEMETRY=1` is set, and `DO_NOT_TRACK=1` always turns it off. ts-builds
 * reads these from the environment only. A committed script, workflow or config command that sets
 * them still turns it on for everyone who runs it. It never sends source or message text, the send
 * waits at most `TELEMETRY_TIMEOUT_MS`, and it never changes the run's exit code.
 *
 * File paths and the repo's name go out only with a second flag, `TS_BUILDS_TELEMETRY_TRACE=1`. The
 * trace adds the git remote, the commit and each finding's repo-relative file and line, so a finding
 * can be opened at that commit, where the repo's own access rules still apply.
 */

/** Bump when the payload's shape changes incompatibly, so the receiver can tell versions apart. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** The most a send can add to a lint run. A send that takes longer is dropped. */
export const TELEMETRY_TIMEOUT_MS = 2000

/** A fixed salt, so the repo id is a stable pseudonym. Anyone who knows the remote URL can recompute it. */
const PROJECT_SALT = "ts-builds-telemetry-v1"

const LOG_PREFIX = "[ts-builds telemetry]"

/** Findings in one trace. The receiver takes up to 300; this keeps a body well under its 64 KB cap. */
export const MAX_TRACE_FINDINGS = 200

export type RuleCounts = {
  readonly errors: number
  readonly warnings: number
  /** Findings hidden by an `eslint-disable` comment. */
  readonly silenced: number
}

export type RuleStats = {
  /** Keyed by rule id, sorted, so the same results always give the same output. */
  readonly rules: Readonly<Record<string, RuleCounts>>
  /** Messages with no rule id: parse errors and other fatal problems. */
  readonly fatal: number
}

export type FindingKind = "error" | "warning" | "silenced"

/** One finding, at a file and line of the traced commit. `file` is relative to the repo root, with `/`. */
export type TraceFinding = {
  readonly rule: string
  /** The rule's message id, when it reports one. Never the message text. */
  readonly message?: string
  readonly kind: FindingKind
  readonly file: string
  readonly line: number
}

/** Where a run's findings can be opened. Only sent with `TS_BUILDS_TELEMETRY_TRACE=1`. */
export type Trace = {
  /** The git remote, normalized to `host/owner/repo`. */
  readonly repo: string
  /** `HEAD` when the lint ran. */
  readonly commit: string
  readonly findings: ReadonlyArray<TraceFinding>
  /** Findings left out: over `MAX_TRACE_FINDINGS`, or in a file that isn't committed as linted. */
  readonly dropped: number
}

export type TelemetryPayload = {
  readonly schema: number
  /** The linted package's `package.json` name, sent as-is. Absent when `package.json` has no name. */
  readonly package?: string
  /** A salted hash of the git remote, so packages from one repo group together without naming it. */
  readonly project?: string
  readonly ci: boolean
  /** The coding agent running the lint, when it can be detected. */
  readonly agent?: string
  readonly fix: boolean
  readonly durationMs: number
  readonly files: number
  readonly fatal: number
  readonly versions: Readonly<Record<string, string>>
  /**
   * Plugin rules that are on, with their severity, from the first linted file's config. Lets the
   * receiver tell a rule with no findings from a rule that's off. Absent when the config can't be read.
   */
  readonly enabled?: Readonly<Record<string, Severity>>
  readonly rules: Readonly<Record<string, RuleCounts>>
  /** Each rule's counts split by the message id it reported. Absent when no finding had one. */
  readonly messages?: Readonly<Record<string, Readonly<Record<string, RuleCounts>>>>
  readonly trace?: Trace
}

export type Severity = "warn" | "error"

/** The plugins and plugin rules in effect for one file, read from ESLint's calculated config. */
export type ActiveConfig = {
  /** Each configured plugin's package name, and the version its `meta` claims. */
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly metaVersion: Option<string> }>
  readonly enabled: Readonly<Record<string, Severity>>
}

export type TelemetryMode =
  | { readonly kind: "off"; readonly warning?: string }
  | { readonly kind: "debug" }
  | { readonly kind: "send"; readonly endpoint: string }

type CountField = keyof RuleCounts

const NO_COUNTS: RuleCounts = { errors: 0, warnings: 0, silenced: 0 }

const isOn = (value: string | undefined): boolean => value !== undefined && /^(1|true|yes)$/i.test(value.trim())

type Hit = { readonly ruleId: string; readonly field: CountField }

/** One hit per message that has a rule id. Messages without one are fatal, and counted apart. */
function hits(result: ESLint.LintResult): ReadonlyArray<Hit> {
  const reported = result.messages.flatMap((m): Hit[] =>
    m.ruleId === null ? [] : [{ ruleId: m.ruleId, field: m.severity === 2 ? "errors" : "warnings" }],
  )
  const suppressed = result.suppressedMessages.flatMap((m): Hit[] =>
    m.ruleId === null ? [] : [{ ruleId: m.ruleId, field: "silenced" }],
  )
  return [...reported, ...suppressed]
}

/** Per-rule counts for a lint run. Pure: the same results always give the same, key-sorted output. */
export function ruleStats(results: readonly ESLint.LintResult[]): RuleStats {
  const unsorted = results.flatMap(hits).reduce<Record<string, RuleCounts>>((acc, h) => {
    const current = acc[h.ruleId] ?? NO_COUNTS
    return { ...acc, [h.ruleId]: { ...current, [h.field]: current[h.field] + 1 } }
  }, {})
  const rules = Object.fromEntries(
    Object.keys(unsorted)
      .toSorted()
      .map((id) => [id, unsorted[id] ?? NO_COUNTS]),
  )
  const fatal = results.reduce((n, r) => n + r.messages.filter((m) => m.ruleId === null).length, 0)
  return { rules, fatal }
}

type Tagged = { readonly message: ESLint.LintResult["messages"][number]; readonly kind: FindingKind }

/** Every message with a rule id, reported or silenced, tagged with how it counts. */
const tagged = (result: ESLint.LintResult): ReadonlyArray<Tagged> => [
  ...result.messages.flatMap((m): Tagged[] =>
    m.ruleId === null ? [] : [{ message: m, kind: m.severity === 2 ? "error" : "warning" }],
  ),
  ...result.suppressedMessages.flatMap((m): Tagged[] => (m.ruleId === null ? [] : [{ message: m, kind: "silenced" }])),
]

const FIELD: Readonly<Record<FindingKind, CountField>> = { error: "errors", warning: "warnings", silenced: "silenced" }

const sortKeys = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/**
 * Per-rule counts split by message id, for the findings that have one. A rule with several messages,
 * such as one that suggests different fixes, then shows which message fires or gets silenced.
 * Message ids are fixed identifiers in the rule, not the message text. Pure and key-sorted.
 */
export function messageStats(results: readonly ESLint.LintResult[]): Record<string, Record<string, RuleCounts>> {
  const nested = results
    .flatMap(tagged)
    .reduce<Record<string, Record<string, RuleCounts>>>((acc, { message, kind }) => {
      const rule = message.ruleId ?? ""
      const id = message.messageId
      if (rule === "" || typeof id !== "string" || id === "") return acc
      const byId = acc[rule] ?? {}
      const current = byId[id] ?? NO_COUNTS
      return { ...acc, [rule]: { ...byId, [id]: { ...current, [FIELD[kind]]: current[FIELD[kind]] + 1 } } }
    }, {})
  return sortKeys(Object.fromEntries(Object.entries(nested).map(([rule, byId]) => [rule, sortKeys(byId)])))
}

/**
 * Every finding as a trace entry, with its file relative to `root` and `/`-separated, sorted by file,
 * line and rule. A file outside `root` has no repo path, so its findings are left out.
 */
export function traceCandidates(results: readonly ESLint.LintResult[], root: string): ReadonlyArray<TraceFinding> {
  return results
    .flatMap((result) => {
      const rel = relative(root, result.filePath)
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return []
      const file = rel.split(sep).join("/")
      return tagged(result).map(({ message, kind }) => ({
        rule: message.ruleId ?? "",
        ...(typeof message.messageId === "string" && message.messageId !== "" ? { message: message.messageId } : {}),
        kind,
        file,
        line: Math.max(1, message.line),
      }))
    })
    .toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : 1)))
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

/** An https URL, or http only to this machine (for tests and a local receiver). */
function isAllowedEndpoint(endpoint: string): boolean {
  return Try(() => new URL(endpoint))
    .map((url) => url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname)))
    .orElse(false)
}

/**
 * What to do with this run's telemetry, from the environment alone. `DO_NOT_TRACK` wins over
 * everything. `TS_BUILDS_TELEMETRY_DEBUG` prints the payload and sends nothing, so you can see
 * exactly what would go out before turning it on.
 */
export function telemetryMode(env: NodeJS.ProcessEnv): TelemetryMode {
  if (isOn(env.DO_NOT_TRACK)) return { kind: "off" }
  if (isOn(env.TS_BUILDS_TELEMETRY_DEBUG)) return { kind: "debug" }
  if (!isOn(env.TS_BUILDS_TELEMETRY)) return { kind: "off" }
  const endpoint = env.TS_BUILDS_TELEMETRY_URL?.trim() ?? ""
  if (endpoint === "")
    return {
      kind: "off",
      warning: "TS_BUILDS_TELEMETRY is on but TS_BUILDS_TELEMETRY_URL isn't set, so nothing was sent.",
    }
  if (!isAllowedEndpoint(endpoint))
    return {
      kind: "off",
      warning: "TS_BUILDS_TELEMETRY_URL must be an https URL (http only to localhost), so nothing was sent.",
    }
  return { kind: "send", endpoint }
}

/**
 * A git remote reduced to `host/owner/repo`, lowercase: no protocol, credentials, port or `.git`.
 * `git@github.com:a/b.git`, `https://user:token@github.com/a/b` and `ssh://git@github.com/a/b`
 * all give `github.com/a/b`.
 */
export function normalizeRemote(remote: string): string {
  const trimmed = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed)
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/^\/+/, "").toLowerCase()
  return Try(() => new URL(trimmed))
    .map((url) => `${url.hostname}${url.pathname}`.replace(/\/+$/, ""))
    .orElse(trimmed)
    .toLowerCase()
}

/** The salted id for a remote. Stable across machines and clones, so one repo's packages group together. */
export function projectId(remote: string): string {
  return createHash("sha256")
    .update(`${PROJECT_SALT}:${normalizeRemote(remote)}`)
    .digest("hex")
    .slice(0, 16)
}

/** The coding agent driving this run, when its env marker is set. */
export function detectAgent(env: NodeJS.ProcessEnv): Option<string> {
  return env.CLAUDECODE === "1" ? Option("claude-code") : Option.none<string>()
}

/** Whether to add the trace: repo, commit, and each finding's file and line. */
export function traceOn(env: NodeJS.ProcessEnv): boolean {
  return isOn(env.TS_BUILDS_TELEMETRY_TRACE)
}

export function isCi(env: NodeJS.ProcessEnv): boolean {
  return isOn(env.CI) || env.GITHUB_ACTIONS === "true"
}

/**
 * The npm package that provides a rule's plugin, splitting the rule id the way ESLint does: at the
 * first slash, or the second for a scoped plugin. `functype/x` is `eslint-plugin-functype`,
 * `@typescript-eslint/x` is `@typescript-eslint/eslint-plugin`, `@scope/name/x` is
 * `@scope/eslint-plugin-name`, and `a/b/c` is `eslint-plugin-a`. Core rules have no plugin.
 */
export function pluginPackage(ruleId: string): Option<string> {
  const parts = ruleId.split("/")
  const first = parts.at(0) ?? ""
  if (parts.length < 2 || first === "") return Option.none<string>()
  if (!first.startsWith("@")) return Option(`eslint-plugin-${first}`)
  const name = parts.length > 2 ? parts.at(1) : undefined
  return Option(name === undefined ? `${first}/eslint-plugin` : `${first}/eslint-plugin-${name}`)
}

/** An npm package name, so a plugin's `meta.name` can't carry a path or other free text. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** A semver version, so a plugin's `meta.version` can't carry free text. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

const ancestors = (dir: string): ReadonlyArray<string> => {
  const parent = dirname(dir)
  return parent === dir ? [dir] : [dir, ...ancestors(parent)]
}

type PackageJson = { readonly name?: unknown; readonly version?: unknown }

const readJson = (path: string): Option<PackageJson> =>
  Try(() => JSON.parse(readFileSync(path, "utf-8")) as PackageJson).toOption()

const versionIn = (path: string): Option<string> =>
  readJson(path).flatMap((pkg) => (typeof pkg.version === "string" ? Option(pkg.version) : Option.none<string>()))

/**
 * A package's installed version, found the way Node finds it: `node_modules/<name>` in `fromDir` or
 * any ancestor. Inside a `node_modules` folder it also checks `<name>` beside it, which is where pnpm
 * puts a package's dependencies (`.pnpm/ts-builds@x/node_modules/eslint-plugin-x`).
 */
export function installedVersion(name: string, fromDir: string): Option<string> {
  const found = ancestors(fromDir)
    .flatMap((dir) => [
      join(dir, "node_modules", name, "package.json"),
      ...(basename(dir) === "node_modules" ? [join(dir, name, "package.json")] : []),
    ])
    .find((path) => existsSync(path))
  return found === undefined ? Option.none<string>() : versionIn(found)
}

/** ts-builds' own root: the nearest ancestor of this module whose `package.json` is ts-builds. */
function tsBuildsRoot(): Option<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = ancestors(here).find((dir) =>
    readJson(join(dir, "package.json"))
      .map((pkg) => pkg.name === "ts-builds")
      .orElse(false),
  )
  return root === undefined ? Option.none<string>() : Option(root)
}

/** A git command's stdout in `dir`, or none when it fails. */
function git(dir: string, args: ReadonlyArray<string>): Option<string> {
  return Try(() =>
    execFileSync("git", [...args], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  ).toOption()
}

const trimmed = (out: Option<string>): Option<string> => out.map((s) => s.trim()).filter((s) => s !== "")

/** The git remote of the repo holding `dir`, if there is one. */
function gitRemote(dir: string): Option<string> {
  return trimmed(git(dir, ["config", "--get", "remote.origin.url"]))
}

/** `host/owner/repo`, as the receiver accepts it. A local-path remote doesn't match, so it isn't traced. */
const TRACE_REPO = /^[a-z0-9.-]{1,100}(\/[a-z0-9._-]{1,100}){2,5}$/
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/

/** NUL-separated paths from `git ... -z`, as a set. */
const pathSet = (out: Option<string>): ReadonlySet<string> =>
  new Set(
    out
      .orElse("")
      .split("\0")
      .filter((p) => p !== ""),
  )

/**
 * The trace for a run: the repo, `HEAD`, and findings in files that are committed as linted. A
 * finding in an untracked file, or in one that differs from `HEAD` (edited, or rewritten by
 * `--fix`), is dropped, because its line wouldn't match the commit. Paths are passed to git
 * literally, so a name like `[slug].astro` isn't read as a pattern.
 */
export function gitTrace(results: readonly ESLint.LintResult[], dir: string): Option<Trace> {
  const root = trimmed(git(dir, ["rev-parse", "--show-toplevel"]))
  const repo = gitRemote(dir)
    .map(normalizeRemote)
    .filter((r) => TRACE_REPO.test(r))
  const commit = trimmed(git(dir, ["rev-parse", "HEAD"])).filter((c) => COMMIT.test(c))
  return root.flatMap((top) =>
    repo.flatMap((name) =>
      commit.map((sha) => {
        const candidates = traceCandidates(results, top)
        const capped = candidates.slice(0, MAX_TRACE_FINDINGS)
        const files = [...new Set(capped.map((f) => f.file))]
        const listed = (args: ReadonlyArray<string>): ReadonlySet<string> =>
          files.length === 0 ? new Set() : pathSet(git(top, ["--literal-pathspecs", ...args, "--", ...files]))
        const tracked = listed(["ls-files", "-z"])
        const changed = listed(["diff", "--name-only", "-z", "HEAD"])
        const findings = capped.filter((f) => tracked.has(f.file) && !changed.has(f.file))
        return { repo: name, commit: sha, findings, dropped: candidates.length - findings.length }
      }),
    ),
  )
}

export type LintRun = {
  readonly results: readonly ESLint.LintResult[]
  readonly fix: boolean
  readonly durationMs: number
  /** The `package.json` name, when there is one. */
  readonly packageName: Option<string>
  readonly eslintVersion: string
  /** The linted package's root. */
  readonly dir: string
  /** ESLint's calculated config for one linted file. Only called when telemetry is on. */
  readonly configFor?: () => Promise<unknown>
}

const severityOf = (entry: unknown): Option<Severity> => {
  const level: unknown = Array.isArray(entry) ? entry[0] : entry
  if (level === 2 || level === "error") return Option<Severity>("error")
  if (level === 1 || level === "warn") return Option<Severity>("warn")
  return Option.none<Severity>()
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const asString = (value: unknown): Option<string> =>
  typeof value === "string" && value !== "" ? Option(value) : Option.none<string>()

/**
 * The plugins and the plugin rules that are on, from `eslint.calculateConfigForFile(...)`. Core
 * rules are left out, and so is ESLint's own `@` namespace.
 */
export function activeConfig(calculated: unknown): ActiveConfig {
  const config = asRecord(calculated)
  const plugins = Object.entries(asRecord(config.plugins))
    .filter(([namespace]) => namespace !== "@")
    .flatMap(([namespace, plugin]) => {
      const meta = asRecord(asRecord(plugin).meta)
      return asString(meta.name)
        .filter((name) => name.length <= 214 && NPM_NAME.test(name))
        .or(pluginPackage(`${namespace}/rule`))
        .map((name) => ({ name, metaVersion: asString(meta.version).filter((v) => SEMVER.test(v)) }))
        .toArray()
    })
  const enabled = Object.fromEntries(
    Object.entries(asRecord(config.rules))
      .filter(([id]) => id.includes("/"))
      .flatMap(([id, entry]) =>
        severityOf(entry)
          .map((severity) => [id, severity] as const)
          .toArray(),
      )
      .toSorted(([a], [b]) => a.localeCompare(b)),
  )
  return { plugins, enabled }
}

/**
 * Versions worth comparing across runs: the toolchain, plus every configured plugin and every plugin
 * whose rules reported. A plugin's installed version wins over the one its `meta` claims, because a
 * hand-written `meta.version` can go stale.
 */
function versionsFor(
  run: LintRun,
  rules: Readonly<Record<string, RuleCounts>>,
  active: Option<ActiveConfig>,
): Record<string, string> {
  const root = tsBuildsRoot()
  const lookup = (name: string): Option<string> =>
    installedVersion(name, run.dir).or(root.flatMap((dir) => installedVersion(name, dir)))
  const configured = active.map((a) => a.plugins).orElse([])
  const claimed = (name: string): Option<string> =>
    Option(configured.find((p) => p.name === name)).flatMap((p) => p.metaVersion)
  const plugins = [...configured.map((p) => p.name), ...Object.keys(rules).flatMap((id) => pluginPackage(id).toArray())]
    .filter((name, i, all) => all.indexOf(name) === i)
    .toSorted()
  const typescript = lookup("typescript")
    .map((v) => [["typescript", v] as const])
    .orElse([])
  const pluginVersions = plugins.flatMap((name) =>
    lookup(name)
      .or(claimed(name))
      .map((v) => [name, v] as const)
      .toArray(),
  )
  return {
    node: process.versions.node,
    "ts-builds": root.flatMap((dir) => versionIn(join(dir, "package.json"))).orElse("unknown"),
    eslint: run.eslintVersion,
    ...Object.fromEntries([...typescript, ...pluginVersions]),
  }
}

/**
 * The payload for one lint run. Holds counts and versions, and no source or message text. File
 * paths and the repo go in `trace`, only with `TS_BUILDS_TELEMETRY_TRACE=1`.
 */
export function buildTelemetryPayload(
  run: LintRun,
  env: NodeJS.ProcessEnv,
  active: Option<ActiveConfig> = Option.none<ActiveConfig>(),
): TelemetryPayload {
  const stats = ruleStats(run.results)
  const project = gitRemote(run.dir).map(projectId)
  const agent = detectAgent(env)
  const messages = messageStats(run.results)
  const trace = traceOn(env) ? gitTrace(run.results, run.dir) : Option.none<Trace>()
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    ...run.packageName.map((name) => ({ package: name })).orElse({}),
    ...project.map((id) => ({ project: id })).orElse({}),
    ci: isCi(env),
    ...agent.map((name) => ({ agent: name })).orElse({}),
    fix: run.fix,
    durationMs: Math.round(run.durationMs),
    files: run.results.length,
    fatal: stats.fatal,
    versions: versionsFor(run, stats.rules, active),
    ...active.map((a) => ({ enabled: a.enabled })).orElse({}),
    rules: stats.rules,
    ...(Object.keys(messages).length > 0 ? { messages } : {}),
    ...trace.map((t) => ({ trace: t })).orElse({}),
  }
}

/**
 * POST the payload. Resolves `true` on a 2xx and `false` otherwise; never rejects. The send is
 * awaited rather than left in flight, so the run's exit can't cut it off or be held open by it.
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  endpoint: string,
  timeoutMs: number = TELEMETRY_TIMEOUT_MS,
): Promise<boolean> {
  const sent = await Try.async(async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    await res.body?.cancel()
    return res.ok
  })
  return sent.orElse(false)
}

/**
 * Report one lint run, as the environment asks. Never throws and never changes the run's result:
 * a failure anywhere in here is dropped.
 */
export async function reportLintTelemetry(
  run: LintRun,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
  // Telemetry must never affect a lint run, so any failure in here is dropped.
  await Try.async(async () => {
    const mode = telemetryMode(env)
    if (mode.kind === "off") {
      if (mode.warning !== undefined) log(`${LOG_PREFIX} ${mode.warning}`)
      return
    }
    const calculated =
      run.configFor === undefined ? Option.none<unknown>() : (await Try.async(run.configFor)).toOption()
    const payload = buildTelemetryPayload(run, env, calculated.map(activeConfig))
    if (mode.kind === "debug") {
      log(`${LOG_PREFIX} TS_BUILDS_TELEMETRY_DEBUG is set, so this was printed and not sent:`)
      log(JSON.stringify(payload, null, 2))
      return
    }
    await sendTelemetry(payload, mode.endpoint)
  })
}
