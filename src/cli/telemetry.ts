import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { ESLint } from "eslint"
import { Option, Try } from "functype"

/**
 * Opt-in lint telemetry: per-rule counts from a `ts-builds lint` run, sent to an endpoint you
 * choose so you can see which rules fire, which get silenced, and whether that changes over time.
 *
 * Off unless `TS_BUILDS_TELEMETRY=1` is set, and `DO_NOT_TRACK=1` always turns it off. It is
 * configured by env vars only, never by `ts-builds.config.json`, so a committed config can't turn
 * it on for everyone who clones a repo. It never sends file paths, source or messages, and it
 * never slows a run by more than `TELEMETRY_TIMEOUT_MS` or changes its exit code.
 */

/** Bump when the payload's shape changes incompatibly, so the receiver can tell versions apart. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** The most a send can add to a lint run. A send that takes longer is dropped. */
export const TELEMETRY_TIMEOUT_MS = 2000

/** A fixed salt, so the repo id is a stable pseudonym. Anyone who knows the remote URL can recompute it. */
const PROJECT_SALT = "ts-builds-telemetry-v1"

const LOG_PREFIX = "[ts-builds telemetry]"

export type RuleCounts = {
  readonly errors: number
  readonly warnings: number
  /** Findings hidden by an `eslint-disable` comment. */
  readonly silenced: number
  /** Findings hidden by ESLint's suppressions file (`eslint --suppress-all`). */
  readonly baselined: number
}

export type RuleStats = {
  /** Keyed by rule id, sorted, so the same results always give the same output. */
  readonly rules: Readonly<Record<string, RuleCounts>>
  /** Messages with no rule id: parse errors and other fatal problems. */
  readonly fatal: number
}

export type TelemetryPayload = {
  readonly schema: number
  /** The linted package's `package.json` name, sent as-is. */
  readonly package: string
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

const NO_COUNTS: RuleCounts = { errors: 0, warnings: 0, silenced: 0, baselined: 0 }

const isOn = (value: string | undefined): boolean => value !== undefined && /^(1|true|yes)$/i.test(value.trim())

type Hit = { readonly ruleId: string; readonly field: CountField }

/** One hit per message that has a rule id. Messages without one are fatal, and counted apart. */
function hits(result: ESLint.LintResult): ReadonlyArray<Hit> {
  const reported = result.messages.flatMap((m): Hit[] =>
    m.ruleId === null ? [] : [{ ruleId: m.ruleId, field: m.severity === 2 ? "errors" : "warnings" }],
  )
  const suppressed = result.suppressedMessages.flatMap((m): Hit[] =>
    m.ruleId === null
      ? []
      : [{ ruleId: m.ruleId, field: m.suppressions.some((x) => x.kind === "external") ? "baselined" : "silenced" }],
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

export function isCi(env: NodeJS.ProcessEnv): boolean {
  return isOn(env.CI) || env.GITHUB_ACTIONS === "true"
}

/**
 * The npm package that provides a rule's plugin, from the rule id's prefix: `functype/x` is
 * `eslint-plugin-functype`, `@typescript-eslint/x` is `@typescript-eslint/eslint-plugin`, and
 * `@scope/name/x` is `@scope/eslint-plugin-name`. Core rules have no prefix and no plugin.
 */
export function pluginPackage(ruleId: string): Option<string> {
  const slash = ruleId.lastIndexOf("/")
  if (slash <= 0) return Option.none<string>()
  const prefix = ruleId.slice(0, slash)
  if (!prefix.startsWith("@")) return Option(`eslint-plugin-${prefix}`)
  const [scope, ...name] = prefix.split("/")
  return Option(name.length === 0 ? `${scope}/eslint-plugin` : `${scope}/eslint-plugin-${name.join("/")}`)
}

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

/** The git remote of the repo holding `dir`, if there is one. */
function gitRemote(dir: string): Option<string> {
  return Try(() =>
    execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim(),
  )
    .toOption()
    .filter((out) => out !== "")
}

export type LintRun = {
  readonly results: readonly ESLint.LintResult[]
  readonly fix: boolean
  readonly durationMs: number
  readonly pkg: string
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
        .or(pluginPackage(`${namespace}/rule`))
        .map((name) => ({ name, metaVersion: asString(meta.version) }))
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

/** The payload for one lint run. Holds counts and versions only: no file paths, source or messages. */
export function buildTelemetryPayload(
  run: LintRun,
  env: NodeJS.ProcessEnv,
  active: Option<ActiveConfig> = Option.none<ActiveConfig>(),
): TelemetryPayload {
  const stats = ruleStats(run.results)
  const project = gitRemote(run.dir).map(projectId)
  const agent = detectAgent(env)
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    package: run.pkg,
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
