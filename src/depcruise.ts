import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

import type { ICruiseResult, IForbiddenRuleType } from "dependency-cruiser"
import { List, Option } from "functype"

import { type Architecture, coreModulesMatching, type ResolvedWorkspace } from "./architecture"

/** The rule that fails an unresolved local or alias import. See `createDepcruise`. */
export const UNRESOLVED_RULE = "not-to-unresolvable-local"

// A specifier that names no package: relative (`./`, `../`), absolute, a subpath import
// (`#x`), or a common alias prefix (`~/`, `@/`). An unresolved bare package name is left
// to the ESLint half, which reports an undeclared dependency, and to type-only packages that
// only have `@types/*` installed. dependency-cruiser refuses a regex with nested repetition,
// so this is a plain anchored alternation.
const LOCAL_SPECIFIER = String.raw`^(\.|/|#|~/|@/)`

const escapeRegex = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

/** A package-name pattern as a regex fragment: `@scope/*` matches any package in the scope. */
const packageFragment = (pattern: string): string => escapeRegex(pattern).replace(/\*/g, "[^/]+")

/** The workspace's `src` and `test` directories, as a path prefix pattern. */
const sourcesOf = (ws: ResolvedWorkspace): string => `^${escapeRegex(ws.dir)}/(src|test)/`

/**
 * The resolved paths a workspace's `deny` list forbids reaching. dependency-cruiser reports
 * an external as its real path, `node_modules/.pnpm/<id>/node_modules/<name>/…`, and a core
 * module by its bare name (`node:fs` becomes `fs`), so each entry becomes both forms.
 */
export function denyPathPattern(deny: readonly string[]): string {
  const externals = deny.map(packageFragment)
  const core = List(deny.flatMap(coreModulesMatching)).distinct().toArray().map(escapeRegex)
  return [
    `(^|/)node_modules/(${externals.join("|")})(/|$)`,
    ...(core.length > 0 ? [`^(node:)?(${core.join("|")})(/|$)`] : []),
  ].join("|")
}

function denyRule(ws: ResolvedWorkspace): IForbiddenRuleType[] {
  const deny = ws.deny ?? []
  if (deny.length === 0) return []
  return [
    {
      name: `deny-reachable:${ws.name}`,
      comment: `${ws.name} (${ws.type}) denies ${deny.join(", ")}, so its code may not reach them through any other module`,
      severity: "error",
      from: { path: sourcesOf(ws) },
      to: { path: denyPathPattern(deny), reachable: true },
    },
  ]
}

export type DepcruiseConfig = {
  /** The dependency-cruiser rule set: transitive `deny` purity, cycles and an integrity check. */
  forbidden: IForbiddenRuleType[]
  /** Cruise options, with `baseDir` fixed to the architecture's root. */
  options: Record<string, unknown>
  /** What to cruise: each workspace's `src`, and its `test` when it has one, relative to `rootDir`. */
  entries: string[]
}

/**
 * Generates a dependency-cruiser config from a validated architecture. It owns what the
 * per-file ESLint rules can't see: a workspace reaching a denied package through another
 * module, and import cycles. It has no `allowed` list, so direct edges stay with ESLint.
 *
 * It forces the settings whose defaults pass silently:
 *
 * - `baseDir` is the architecture's absolute `rootDir`, so a run from a workspace directory
 *   matches the same paths as one from the root.
 * - Workspace packages resolve through their symlinks with `exportsFields` and
 *   `conditionNames` set, and each workspace's `tsconfig.json` is a project reference, so
 *   its own `paths` aliases resolve without leaking into another workspace.
 * - Type-only imports are kept, matching the ESLint half, and excluded only from cycles.
 * - An import from workspace code that can't be resolved, and isn't a bare package name,
 *   is an error: an unresolved alias or relative path would silently end a reachability
 *   chain.
 *
 * `runDepcruise` adds two checks a config can't express: every rule must match at least
 * one cruised file, and the TypeScript transpiler must be available.
 */
export function createDepcruise(architecture: Architecture): DepcruiseConfig {
  const workspaces = Object.values(architecture.workspaces)
  const allSources = `^(${workspaces.map((ws) => `${escapeRegex(ws.dir)}/(src|test)`).join("|")})/`
  const tsconfigDirs = workspaces.flatMap((ws) =>
    ws.tsconfig === undefined ? [] : [join(architecture.rootDir, ws.dir)],
  )
  const firstTsconfig = workspaces.find((ws) => ws.tsconfig !== undefined)?.tsconfig
  const forbidden: IForbiddenRuleType[] = [
    ...workspaces.flatMap(denyRule),
    {
      name: "no-circular",
      comment: "A runtime import cycle between workspace modules. Type-only imports don't count.",
      severity: "error",
      from: { path: allSources },
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: UNRESOLVED_RULE,
      comment:
        "A local, alias or subpath import that doesn't resolve. It would end a reachability chain without a finding.",
      severity: "error",
      from: { path: allSources },
      to: { couldNotResolve: true, path: LOCAL_SPECIFIER },
    },
  ]
  const options = {
    baseDir: architecture.rootDir,
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      ...(firstTsconfig === undefined ? {} : { tsconfig: { configFile: firstTsconfig, references: tsconfigDirs } }),
    },
  }
  const entries = workspaces.flatMap((ws) =>
    ["src", "test"]
      .map((sub) => `${ws.dir}/${sub}`)
      .filter(
        (rel) => existsSync(join(architecture.rootDir, rel)) && statSync(join(architecture.rootDir, rel)).isDirectory(),
      ),
  )
  return { forbidden, options, entries }
}

export type DepcruiseViolation = { rule: string; from: string; to: string; via: string[] }

export type DepcruiseReport = {
  /** 0 when clean, 1 when a rule is violated, 2 when the check itself couldn't run. */
  exitCode: 0 | 1 | 2
  /** Human-readable output, for a terminal. */
  output: string
  violations: DepcruiseViolation[]
}

/** The rules whose `from` pattern matches no cruised module: each would pass without checking anything. */
export function rulesMatchingNothing(forbidden: readonly IForbiddenRuleType[], result: ICruiseResult): string[] {
  return forbidden
    .filter((rule) => {
      const from = typeof rule.from.path === "string" ? new RegExp(rule.from.path) : undefined
      return from !== undefined && !result.modules.some((module) => from.test(module.source))
    })
    .map((rule) => rule.name ?? "(unnamed rule)")
}

/** A resolved path as a reader would name it: `node_modules/.pnpm/<id>/node_modules/pg/x.js` is `pg/x.js`. */
export const displayPath = (path: string): string => path.replace(/^(.*\/)?node_modules\//, "")

/**
 * The report as text. dependency-cruiser's own `format()` rejects this result, because its
 * schema doesn't list enhanced-resolve's `tsconfig` option that the config passes through.
 */
export function formatViolations(violations: readonly DepcruiseViolation[], totalCruised: number): string {
  const lines = violations.map((violation) => {
    const via = violation.via.length > 0 ? `\n      via ${violation.via.map(displayPath).join(" → ")}` : ""
    return `  error ${violation.rule}: ${displayPath(violation.from)} → ${displayPath(violation.to)}${via}`
  })
  const summary =
    violations.length === 0
      ? `✔ no dependency violations found (${totalCruised} modules cruised)`
      : `✘ ${violations.length} dependency violation${violations.length === 1 ? "" : "s"} (${totalCruised} modules cruised)`
  return [...lines, summary].join("\n")
}

type Transpiler = { name: string; available: boolean }

/**
 * Why dependency-cruiser can't read this repo's sources, if it can't. It parses TypeScript only
 * when it can load the `typescript` package; without it, a .ts file reads as plain JavaScript
 * and its imports may silently go missing.
 */
export function transpilerProblem(transpilers: readonly Transpiler[]): Option<string> {
  return transpilers.some((transpiler) => transpiler.name === "typescript" && transpiler.available)
    ? Option.none<string>()
    : Option("dependency-cruiser can't load TypeScript, so it can't read .ts files. Install typescript.")
}

const fatal = (output: string): DepcruiseReport => ({ exitCode: 2, output, violations: [] })

/**
 * Runs the generated config with dependency-cruiser in-process and checks the result. Under
 * pnpm a consumer can't run dependency-cruiser's own CLI, since its binary isn't linked into
 * the consumer, so ts-builds runs it. It never reads the working directory.
 */
export async function runDepcruise(architecture: Architecture): Promise<DepcruiseReport> {
  const { cruise, getAvailableTranspilers } = await import("dependency-cruiser")
  const problem = transpilerProblem(getAvailableTranspilers())
  if (problem.isSome()) return fatal(problem.orThrow())
  const config = createDepcruise(architecture)
  if (config.entries.length === 0) return fatal("No workspace has a src or test directory to cruise.")

  const cruised = await cruise(config.entries, {
    ...config.options,
    validate: true,
    ruleSet: { forbidden: config.forbidden },
  }).then(
    (output) => Option(output.output as ICruiseResult),
    (error: unknown) => {
      console.error(`dependency-cruiser failed: ${error instanceof Error ? error.message : String(error)}`)
      return Option.none<ICruiseResult>()
    },
  )
  if (cruised.isNone()) return fatal("dependency-cruiser failed before checking anything; see the error above.")
  const result = cruised.orThrow()
  if (result.summary.totalCruised === 0) return fatal("dependency-cruiser cruised no modules.")
  const idle = rulesMatchingNothing(config.forbidden, result)
  if (idle.length > 0) {
    return fatal(`These rules match no cruised file, so they would pass without checking anything: ${idle.join(", ")}`)
  }

  const violations = result.summary.violations.map((violation): DepcruiseViolation => ({
    rule: violation.rule.name,
    from: violation.from,
    to: violation.to,
    // The modules between the two ends. dependency-cruiser ends a reach path with its target.
    via: (violation.via ?? violation.cycle ?? []).map((step) => step.name).filter((name) => name !== violation.to),
  }))
  const errors = result.summary.violations.filter((violation) => violation.rule.severity === "error").length
  return {
    exitCode: errors > 0 ? 1 : 0,
    output: formatViolations(violations, result.summary.totalCruised),
    violations,
  }
}
