import { createRequire } from "node:module"

import type { Linter, Rule } from "eslint"
import boundaries from "eslint-plugin-boundaries"

import type { Architecture, ResolvedWorkspace } from "./architecture"

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

/**
 * The policies for one workspace, in the order the plugin reads them: later policies
 * override earlier ones, so `deny` comes last and wins over a declared dependency.
 */
function workspacePolicies(ws: ResolvedWorkspace, testExternals: readonly string[]): Policy[] {
  const label = `${ws.name} (${ws.type})`
  const deny = ws.deny ?? []
  return [
    // A test file importing ../src crosses from the test element to the src one.
    { from: fromWorkspace(ws), allow: { to: { element: { type: ws.name } } } },
    ...(ws.allowedWorkspaces.length > 0
      ? [{ from: fromWorkspace(ws), allow: { to: { element: { type: [...ws.allowedWorkspaces] } } } }]
      : []),
    ...(ws.dependencies.length > 0 ? [{ from: fromWorkspace(ws), allow: toExternal(ws.dependencies) }] : []),
    {
      from: fromWorkspaceTests(ws),
      allow: toExternal([...ws.dependencies, ...ws.devDependencies, ...testExternals]),
    },
    { from: fromWorkspace(ws), allow: { to: { module: { origin: "core" } } } },
    ...(deny.length > 0
      ? [
          {
            from: fromWorkspace(ws),
            disallow: { to: { module: { origin: ["external", "core"], source: [...deny] } } },
            message: `${label} denies imports of ${deny.join(", ")} in its architecture policy`,
          },
        ]
      : []),
  ]
}

const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?:\s+([^]*?))?\s*(?:--[^]*)?$/

/**
 * Reports an `eslint-disable` comment that names a `boundaries/*` rule, or names no
 * rule at all, since a blanket disable silences the boundary rules too.
 *
 * A blanket disable is reported at line 1, ahead of the comment, so the comment can't
 * silence the report itself. One at the very top of a file still silences everything,
 * this rule included; that is how ESLint applies directives.
 */
export const noBoundariesDisable: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    docs: { description: "Disallow eslint-disable comments that silence the boundary rules" },
    messages: {
      named: "Disabling {{rules}} is not allowed. Boundary rules have no inline escape: change the policy instead.",
      blanket: "A blanket eslint-disable also silences the boundary rules. Name the rules you mean to disable.",
    },
  },
  create(context) {
    return {
      Program() {
        context.sourceCode.getAllComments().forEach((comment) => {
          const match = DIRECTIVE.exec(comment.value)
          if (match === null || comment.loc === null || comment.loc === undefined) return
          const rules = (match.at(1) ?? "")
            .split(",")
            .map((rule) => rule.trim())
            .filter((rule) => rule.length > 0)
          if (rules.length === 0) {
            context.report({ loc: { line: 1, column: 0 }, messageId: "blanket" })
            return
          }
          const named = rules.filter((rule) => rule.startsWith("boundaries/"))
          if (named.length > 0)
            context.report({ loc: comment.loc, messageId: "named", data: { rules: named.join(", ") } })
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
    "boundaries/files": [
      { pattern: "**/test/**", category: "test" },
      { pattern: "**/*.{test,spec}.*", category: "test" },
    ],
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
