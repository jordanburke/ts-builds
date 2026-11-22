import { existsSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

import type { cruise as Cruise, DependencyType, ICruiseResult, IForbiddenRuleType } from "dependency-cruiser"
import { List, Option } from "functype"

import { type Architecture, coreModulesMatching, type ResolvedWorkspace, typedPackages } from "./architecture"

/** The prefix of each workspace's unresolved-import rule: `not-to-unresolvable:<workspace>`. */
export const UNRESOLVED_RULE = "not-to-unresolvable"

const escapeRegex = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

/** A package-name pattern as a regex fragment: `@scope/*` matches any package in the scope. */
const packageFragment = (pattern: string): string => escapeRegex(pattern).replace(/\*/g, "[^/]+")

/** The prefix of the rules on what a workspace's `ownDirs` code imports: `own-dirs-<check>:<workspace>`. */
export const OWN_DIRS_RULE = "own-dirs"

/** The dependency types of an import of a package, declared or not (`npm-no-pkg`). */
const PACKAGE_DEPENDENCY_TYPES: ReadonlyArray<DependencyType> = [
  "npm",
  "npm-dev",
  "npm-optional",
  "npm-peer",
  "npm-bundled",
  "npm-no-pkg",
]

/** Folders of a workspace, as a path prefix pattern. */
const foldersOf = (ws: ResolvedWorkspace, folders: readonly string[]): string =>
  `^${escapeRegex(ws.dir)}/(${folders.map(escapeRegex).join("|")})/`

/** The workspace's `src` and `test` directories, as a path prefix pattern. */
const sourcesOf = (ws: ResolvedWorkspace): string => foldersOf(ws, ["src", "test"])

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

/**
 * Fails every import from a workspace's code that doesn't resolve, except a package the
 * workspace declares, including through its `@types/*` package. A declared package that
 * doesn't resolve is a type-only one with only `@types/*` installed, which is fine. Anything
 * else, an alias above all, would end a reachability chain with no finding: ESLint's resolver
 * can resolve an alias dependency-cruiser can't, so neither half would report it.
 */
function unresolvedRule(ws: ResolvedWorkspace): IForbiddenRuleType {
  const declared = List([
    ...ws.dependencies,
    ...ws.devDependencies,
    ...typedPackages(ws.devDependencies),
    ...typedPackages(ws.dependencies),
  ])
    .distinct()
    .toArray()
    .map(escapeRegex)
  return {
    name: `${UNRESOLVED_RULE}:${ws.name}`,
    comment: `An import from ${ws.name} that doesn't resolve and isn't a package it declares. It would end a reachability chain without a finding.`,
    severity: "error",
    // ownDirs too: a followed ownDirs file with an unresolved import would end a chain silently.
    from: { path: foldersOf(ws, ["src", "test", ...ws.ownDirs]) },
    to: {
      couldNotResolve: true,
      ...(declared.length > 0 ? { pathNot: `^(${declared.join("|")})(/|$)` } : {}),
    },
  }
}

/**
 * ESLint doesn't lint the files in a workspace's `ownDirs`, so these rules check what they
 * import. A local import must land in the workspace's own `src` or `ownDirs`, or in the `src` of
 * a workspace its `allow` names, and not on a test file there. A package must be one the
 * workspace declares. The permitted places are named folders, never a whole workspace folder:
 * workspace folders nest, and a folder beside them leads anywhere. A `deny` reach through
 * `ownDirs` code is reported from `src` and `test`, and an unresolved import by
 * `unresolvedRule`. They see the files that `src` or `test` reach, since nothing else is cruised.
 */
function ownDirRules(
  ws: ResolvedWorkspace,
  workspaces: readonly ResolvedWorkspace[],
): ReadonlyArray<IForbiddenRuleType> {
  if (ws.ownDirs.length === 0) return []
  const from = { path: foldersOf(ws, ws.ownDirs) }
  const allowedSources = workspaces
    .filter((other) => ws.allowedWorkspaces.includes(other.name))
    .map((other) => `${escapeRegex(other.dir)}/src`)
  const permitted = [`${escapeRegex(ws.dir)}/(${["src", ...ws.ownDirs].map(escapeRegex).join("|")})`, ...allowedSources]
  const permittedSources = [`${escapeRegex(ws.dir)}/src`, ...allowedSources]
  const otherNames = workspaces.filter((other) => other.name !== ws.name).map((other) => escapeRegex(other.name))
  // A workspace installed as a copy (pnpm's injected workspace dependencies) is a package, so
  // the boundary rule passes it; its name still says which workspace it is. Every copy is
  // refused, allowed or not, as ESLint refuses one from src: it resolves into node_modules under
  // a workspace's name, which is never a declared external.
  const workspacePackage: IForbiddenRuleType = {
    name: `${OWN_DIRS_RULE}-workspace-package:${ws.name}`,
    comment: `${ws.name}'s ownDirs code imports an installed copy of a workspace; import the workspace itself`,
    severity: "error",
    from,
    to: { path: `(^|/)node_modules/(${otherNames.join("|")})/` },
  }
  return [
    {
      name: `${OWN_DIRS_RULE}-boundary:${ws.name}`,
      comment: `${ws.name}'s ownDirs code imports a file outside its own src and ownDirs and outside an allowed workspace's src`,
      severity: "error",
      from,
      // Resolved, and not core or a package import, which `not-to-unresolvable` and
      // `own-dirs-undeclared` own. Packages are told apart by dependency type, never by a
      // node_modules path: a relative import of ../node_modules/x is a local file reaching past
      // the package check, and it is reported here.
      to: {
        couldNotResolve: false,
        dependencyTypesNot: [...PACKAGE_DEPENDENCY_TYPES, "core"],
        pathNot: `^(${permitted.join("|")})/`,
      },
    },
    ...(otherNames.length > 0 ? [workspacePackage] : []),
    {
      name: `${OWN_DIRS_RULE}-test-file:${ws.name}`,
      comment: `${ws.name}'s ownDirs code imports a test file, which source files may not`,
      severity: "error",
      from,
      to: { path: `^(${permittedSources.join("|")})/.*[.](test|spec)[.][^/]+$` },
    },
    {
      name: `${OWN_DIRS_RULE}-undeclared:${ws.name}`,
      comment: `${ws.name}'s ownDirs code imports a package its package.json doesn't declare`,
      severity: "error",
      from,
      to: { dependencyTypes: ["npm-no-pkg"] },
    },
  ]
}

function denyRule(ws: ResolvedWorkspace): ReadonlyArray<IForbiddenRuleType> {
  const deny = ws.deny ?? []
  if (deny.length === 0) return []
  return [
    {
      name: `deny-reachable:${ws.name}`,
      comment: `${ws.name} (${ws.type}) denies ${deny.join(", ")}, so its code may not reach them through other workspace modules`,
      severity: "error",
      from: { path: sourcesOf(ws) },
      to: { path: denyPathPattern(deny), reachable: true },
    },
  ]
}

export type DepcruiseConfig = {
  /** The dependency-cruiser rule set: transitive `deny` purity, cycles and an integrity check. */
  forbidden: ReadonlyArray<IForbiddenRuleType>
  /** Cruise options, with `baseDir` fixed to the architecture's root. */
  options: Record<string, unknown>
  /** What to cruise: each workspace's `src`, and its `test` when it has one, relative to `rootDir`. */
  entries: ReadonlyArray<string>
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
 * - An import from workspace code that can't be resolved is an error, unless it names a
 *   package the workspace declares: an unresolved alias or path would silently end a
 *   reachability chain.
 *
 * `runDepcruise` adds two checks a config can't express: every rule must match at least
 * one cruised file, and the TypeScript transpiler must be available.
 */
export function createDepcruise(architecture: Architecture): DepcruiseConfig {
  // The real path: dependency-cruiser follows a workspace's symlink to its real path, so under a
  // symlinked root (macOS /var is /private/var) every module reached through another
  // workspace would sit outside baseDir, as ../.. paths that no rule's pattern matches.
  const rootDir = realpathSync(architecture.rootDir)
  const workspaces = Object.values(architecture.workspaces)
  const allSources = `^(${workspaces.map((ws) => `${escapeRegex(ws.dir)}/(src|test)`).join("|")})/`
  const tsconfigDirs = workspaces.flatMap((ws) => (ws.tsconfig === undefined ? [] : [join(rootDir, ws.dir)]))
  const firstTsconfig = workspaces.find((ws) => ws.tsconfig !== undefined)?.dir
  const forbidden: ReadonlyArray<IForbiddenRuleType> = [
    ...workspaces.flatMap(denyRule),
    {
      name: "no-circular",
      comment: "A runtime import cycle between workspace modules. Type-only imports don't count.",
      severity: "error",
      from: { path: allSources },
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    ...workspaces.map(unresolvedRule),
    ...workspaces.flatMap((ws) => ownDirRules(ws, workspaces)),
  ]
  const options = {
    baseDir: rootDir,
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: Array.from(EXPORTS_FIELDS),
      // No "types": a workspace exporting `{ "types": "./dist/index.d.ts", "import": "./src/index.ts" }`
      // must resolve to the code, not to a declaration file that ends the chain.
      conditionNames: Array.from(CONDITION_NAMES),
      ...(firstTsconfig === undefined
        ? {}
        : { tsconfig: { configFile: join(rootDir, firstTsconfig, "tsconfig.json"), references: tsconfigDirs } }),
    },
  }
  const entries = workspaces.flatMap((ws) =>
    ["src", "test"]
      .map((sub) => `${ws.dir}/${sub}`)
      .filter((rel) => existsSync(join(rootDir, rel)) && statSync(join(rootDir, rel)).isDirectory()),
  )
  return { forbidden, options, entries }
}

export type DepcruiseViolation = { rule: string; from: string; to: string; via: ReadonlyArray<string> }

export type DepcruiseReport = {
  /** 0 when clean, 1 when a rule is violated, 2 when the check itself couldn't run. */
  exitCode: 0 | 1 | 2
  /** Human-readable output, for a terminal. */
  output: string
  violations: ReadonlyArray<DepcruiseViolation>
}

/**
 * The rules whose `from` pattern matches no cruised module: each would pass without checking
 * anything. The `ownDirs` rules are exempt: their folder exists (`defineArchitecture` checks),
 * and when nothing in `src` or `test` imports from it there is no code of it to check.
 */
export function rulesMatchingNothing(
  forbidden: readonly IForbiddenRuleType[],
  result: ICruiseResult,
): ReadonlyArray<string> {
  return forbidden
    .filter((rule) => !(rule.name ?? "").startsWith(`${OWN_DIRS_RULE}-`))
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
  // Any failure before a result exists is "couldn't check" (exit 2), never a crash.
  return checkArchitecture(architecture).catch((error: unknown) =>
    fatal(
      `dependency-cruiser couldn't check the architecture: ${error instanceof Error ? error.message : String(error)}`,
    ),
  )
}

const EXPORTS_FIELDS: ReadonlyArray<string> = ["exports"]
const CONDITION_NAMES: ReadonlyArray<string> = ["import", "require", "node", "default"]

async function checkArchitecture(architecture: Architecture): Promise<DepcruiseReport> {
  const { cruise, getAvailableTranspilers } = await import("dependency-cruiser")
  return transpilerProblem(getAvailableTranspilers()).fold(
    () => cruiseArchitecture(cruise, architecture),
    (problem) => Promise.resolve(fatal(problem)),
  )
}

async function cruiseArchitecture(cruise: typeof Cruise, architecture: Architecture): Promise<DepcruiseReport> {
  const config = createDepcruise(architecture)
  if (config.entries.length === 0) return fatal("No workspace has a src or test directory to cruise.")

  const cruised = await cruise(Array.from(config.entries), {
    ...config.options,
    validate: true,
    ruleSet: { forbidden: Array.from(config.forbidden) },
  })
  const result = cruised.output as ICruiseResult
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
