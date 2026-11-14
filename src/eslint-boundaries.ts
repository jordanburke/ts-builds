import { builtinModules, createRequire } from "node:module"

import type { Linter, Rule } from "eslint"
import boundaries from "eslint-plugin-boundaries"
import { List, Option } from "functype"

import { type Architecture, matchesPackagePattern, type ResolvedWorkspace } from "./architecture"

/**
 * Every source file a workspace can hold, under `src` or `test`. The glob is not
 * anchored at the root on purpose: ESLint resolves `files` against the directory of the
 * config that loads it, so a root-anchored glob stops matching when a workspace's own
 * `eslint.config.js` re-exports the root config.
 */
export const BOUNDARY_FILES = "**/{src,test}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"

// Absolute, so the resolver loads from ts-builds' own dependencies: under pnpm a
// consumer can't require it by name unless it installs it too.
const TYPESCRIPT_RESOLVER = createRequire(import.meta.url).resolve("eslint-import-resolver-typescript")

type Policy = {
  from: Record<string, unknown>
  allow?: Record<string, unknown>
  disallow?: Record<string, unknown>
  message?: string
}

const fromWorkspace = (ws: ResolvedWorkspace): Record<string, unknown> => ({ element: { type: ws.name } })
const fromWorkspaceTests = (ws: ResolvedWorkspace): Record<string, unknown> => ({
  element: { type: ws.name },
  file: { categories: ["test"] },
})
const toExternal = (source: readonly string[]): Record<string, unknown> => ({
  to: { module: { origin: "external", source: [...source] } },
})

const CORE_MODULES = builtinModules.map((name) => name.replace(/^node:/, ""))

/**
 * A `deny` list as module sources. The plugin matches a core module by its literal
 * spelling, so an entry naming one, or a glob matching some, also gets the other spelling:
 * `fs` adds `node:fs`, and `node:o*` adds `os` and `node:os`.
 */
export function denySources(deny: readonly string[]): string[] {
  const core = deny.flatMap((entry) => {
    const bare = entry.replace(/^node:/, "")
    return CORE_MODULES.filter((name) => matchesPackagePattern(bare, name)).flatMap((name) => [name, `node:${name}`])
  })
  return List([...deny, ...core])
    .distinct()
    .toArray()
}

/**
 * The packages a declared `@types/*` package describes: `@types/lodash` describes `lodash`,
 * and `@types/babel__core` describes `@babel/core`.
 */
export function typedPackages(declared: readonly string[]): string[] {
  return declared
    .filter((name) => name.startsWith("@types/"))
    .map((name) => name.slice("@types/".length))
    .map((name) => (name.includes("__") ? `@${name.replace("__", "/")}` : name))
}

/**
 * The policies for one workspace, in the order the plugin reads them: later policies
 * override earlier ones, so `deny` comes last and wins over a declared dependency.
 */
function workspacePolicies(ws: ResolvedWorkspace, testExternals: readonly string[]): Policy[] {
  const label = `${ws.name} (${ws.type})`
  const deny = ws.deny ?? []
  // A type-only import is erased, so it may come from a devDependency, or from a package
  // only its @types package declares.
  const typeOnly = [...ws.devDependencies, ...typedPackages([...ws.dependencies, ...ws.devDependencies])]
  return [
    // A test file importing ../src crosses from the test element to the src one.
    { from: fromWorkspace(ws), allow: { to: { element: { type: ws.name } } } },
    ...(ws.allowedWorkspaces.length > 0
      ? [{ from: fromWorkspace(ws), allow: { to: { element: { type: [...ws.allowedWorkspaces] } } } }]
      : []),
    ...(ws.dependencies.length > 0 ? [{ from: fromWorkspace(ws), allow: toExternal(ws.dependencies) }] : []),
    ...(typeOnly.length > 0
      ? [{ from: fromWorkspace(ws), allow: { ...toExternal(typeOnly), dependency: { kind: "type" } } }]
      : []),
    {
      from: fromWorkspaceTests(ws),
      allow: toExternal([...ws.dependencies, ...ws.devDependencies, ...testExternals]),
    },
    { from: fromWorkspace(ws), allow: { to: { module: { origin: "core" } } } },
    // Source files may not import test files, in this workspace or another. A workspace's
    // own test files may import each other, such as a shared test helper.
    {
      from: fromWorkspace(ws),
      disallow: { to: { file: { categories: ["test"] } } },
      message: `${label}: source files may not import test files`,
    },
    { from: fromWorkspaceTests(ws), allow: { to: { element: { type: ws.name }, file: { categories: ["test"] } } } },
    ...(deny.length > 0
      ? [
          {
            from: fromWorkspace(ws),
            disallow: { to: { module: { origin: ["external", "core"], source: denySources(deny) } } },
            message: `${label} denies imports of ${deny.join(", ")} in its architecture policy`,
          },
        ]
      : []),
  ]
}

// `eslint-disable`, `eslint-disable-line` and `eslint-disable-next-line`, with an
// optional rule list and `-- reason`. Like ESLint, a reason starts only at a run of two or
// more dashes with whitespace on both sides, so `"a--b"` stays part of the list.
const DISABLE_DIRECTIVE = /^\s*eslint-disable(-next-line|-line)?(\s[^]*)?$/
const REASON_SEPARATOR = /\s-{2,}\s/
// `/* eslint rule: "off", … */`, which reconfigures rules for the whole file.
const CONFIG_DIRECTIVE = /^\s*eslint\s/

// Any mention of a boundary rule or the guard, however the comment is written. ESLint's own
// directive parser accepts more shapes (quotes, no commas, braces, arrays) than a re-parse
// would track, so the comment text is scanned instead of parsed.
const GUARDED_NAME = /(?:boundaries\/[\w-]+|ts-builds\/no-boundaries-disable)/g

const guardedNames = (text: string): string[] =>
  List([...text.matchAll(GUARDED_NAME)].map((match) => match[0]))
    .distinct()
    .toArray()

/**
 * `blanket` is a disable directive with no rule list. `names` are the boundary and guard
 * rules the comment mentions anywhere, its reason included: matching ESLint's split of the
 * reason exactly isn't worth the risk, and a reason that names a boundary rule is rare.
 */
type Directive = { kind: "block" | "line" | "next-line" | "config"; blanket: boolean; names: string[] }

function parseDirective(comment: { type: string; value: string }): Option<Directive> {
  const disable = DISABLE_DIRECTIVE.exec(comment.value)
  if (disable !== null) {
    const list = (` ${disable.at(2) ?? ""} `.split(REASON_SEPARATOR)[0] ?? "").trim()
    const suffix = disable.at(1)
    const kind = suffix === "-line" ? "line" : suffix === "-next-line" ? "next-line" : "block"
    return Option({ kind, blanket: list.length === 0, names: guardedNames(comment.value) })
  }
  // Config comments are only read from block comments.
  if (comment.type !== "Block" || !CONFIG_DIRECTIVE.test(comment.value)) return Option.none<Directive>()
  return Option({ kind: "config" as const, blanket: false, names: guardedNames(comment.value) })
}

/**
 * The line to report a directive on: one its own range doesn't cover, where there is one.
 * A `-next-line` directive covers the line after it, a `-line` directive its own line, and
 * a block directive everything from the comment on.
 */
function reportLine(kind: Directive["kind"], line: number, column: number, lastLine: number): number {
  if (kind === "line") return line < lastLine ? line + 1 : Math.max(1, line - 1)
  if (kind === "block") return line > 1 || column > 0 ? 1 : line
  return line
}

/**
 * Reports a comment that could silence the boundary rules:
 *
 * - an `eslint-disable` directive that names a `boundaries/*` rule or this rule;
 * - a blanket `eslint-disable` with no rule list, which silences every rule;
 * - an `/* eslint … *\/` config comment that names a `boundaries/*` rule or this rule.
 *
 * Each is reported on a line its own range doesn't cover, so the directive can't silence
 * the report. ESLint applies directives before any rule runs, so some comments still can't
 * be reported: a block directive at the very start of a file, a `-line` directive in a
 * one-line file, a config comment that turns this rule itself off, and combinations of
 * directives that cover each other's report lines. Only a lint run with inline config off
 * (`--no-inline-config`) closes those.
 */
export const noBoundariesDisable: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    docs: { description: "Disallow eslint-disable and eslint config comments that silence the boundary rules" },
    messages: {
      named: "Disabling {{rules}} is not allowed. Boundary rules have no inline escape: change the policy instead.",
      blanket: "A blanket eslint-disable also silences the boundary rules. Name the rules you mean to disable.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const lastLine = program.loc?.end.line ?? 1
        context.sourceCode.getAllComments().forEach((comment) => {
          if (comment.loc === null || comment.loc === undefined) return
          const { start } = comment.loc
          parseDirective(comment).forEach((directive) => {
            const line = reportLine(directive.kind, start.line, start.column, lastLine)
            const loc = { line, column: 0 }
            if (directive.blanket) {
              context.report({ loc, messageId: "blanket" })
              return
            }
            if (directive.names.length > 0) {
              context.report({ loc, messageId: "named", data: { rules: directive.names.join(", ") } })
            }
          })
        })
      },
    }
  },
}

export type BoundariesConfig = {
  /** Flat-config blocks to spread into `eslint.config.js`. */
  readonly configs: Linter.Config[]
  /** The plugin settings alone, for a config that reuses them, such as a fast hook config. */
  readonly settings: Record<string, unknown>
  /** The `boundaries/dependencies` policies alone. */
  readonly policies: readonly Policy[]
}

/**
 * Generates eslint-plugin-boundaries config from a validated architecture.
 *
 * It forces the settings whose defaults pass silently:
 *
 * - `boundaries/root-path` is the architecture's absolute `rootDir`, never the cwd.
 * - Elements are each workspace's `src` and `test` directories, not its root, so a
 *   declared external in the workspace's own `node_modules` is never inside an element.
 * - Imports resolve through `eslint-import-resolver-typescript` with every workspace's
 *   tsconfig listed, so workspace packages that export raw `.ts` resolve as local.
 * - `default: "disallow"`, `checkAllOrigins` and `checkUnknownLocals` are on, and
 *   `boundaries/no-unknown-files` is an error: a wrong root makes every file unknown.
 * - Disabling a `boundaries/*` rule in a comment is an error.
 */
export function createBoundaries(architecture: Architecture): BoundariesConfig {
  const workspaces = Object.values(architecture.workspaces)
  const tsconfigs = workspaces.flatMap((ws) => (ws.tsconfig === undefined ? [] : [ws.tsconfig]))
  const settings: Record<string, unknown> = {
    "boundaries/root-path": architecture.rootDir,
    "boundaries/elements": workspaces.flatMap((ws) => [
      { type: ws.name, pattern: `${ws.dir}/src` },
      { type: ws.name, pattern: `${ws.dir}/test` },
    ]),
    // Scoped to each workspace, so a workspace under a directory named test, or a
    // src/test directory, isn't tagged as tests wholesale.
    "boundaries/files": workspaces.flatMap((ws) => [
      { pattern: `${ws.dir}/test/**`, category: "test" },
      { pattern: `${ws.dir}/src/**/*.{test,spec}.*`, category: "test" },
    ]),
    "import/resolver": {
      [TYPESCRIPT_RESOLVER]: {
        ...(tsconfigs.length > 0 ? { project: tsconfigs } : {}),
        noWarnOnMultipleProjects: true,
      },
    },
  }
  const policies = workspaces.flatMap((ws) => workspacePolicies(ws, architecture.testPolicy.allowExternals))
  const configs: Linter.Config[] = [
    {
      name: "ts-builds/boundaries",
      files: [BOUNDARY_FILES],
      plugins: {
        boundaries: boundaries as unknown as NonNullable<Linter.Config["plugins"]>[string],
        "ts-builds": { rules: { "no-boundaries-disable": noBoundariesDisable } },
      },
      settings,
      rules: {
        "boundaries/no-unknown-files": "error",
        "boundaries/dependencies": [
          "error",
          { default: "disallow", checkAllOrigins: true, checkUnknownLocals: true, policies },
        ],
        "ts-builds/no-boundaries-disable": "error",
      },
    },
  ]
  return { configs, settings, policies }
}
