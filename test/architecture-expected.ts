import { spawnSync } from "node:child_process"
import { join } from "node:path"

/**
 * What linting test/fixtures/architecture must report, shared by the in-repo spec and the
 * packed-install spec. One violation per file, each on line 1; every other file is clean.
 */
export type Finding = { file: string; line: number; rule: string; message: string }

const DENIED = "boundaries/dependencies (denied)"
const TEST_IMPORT = "boundaries/dependencies (imports a test file)"
const NO_POLICY = "boundaries/dependencies (no policy)"
const violation = (file: string, kind: string): string => `packages/rules/src/violations/${file}:1 ${kind}`

export const EXPECTED = [
  `apps/api/src/imports-other-test.ts:1 ${TEST_IMPORT}`,
  `apps/api/src/undeclared.ts:1 ${NO_POLICY}`,
  `packages/rules/src/test/not-a-test-dir.ts:1 ${NO_POLICY}`,
  violation("denied-core.ts", DENIED),
  violation("denied-declared.ts", DENIED),
  violation("denied-glob.ts", DENIED),
  violation("denied-subpath.ts", DENIED),
  violation("dev-dependency-in-src.ts", NO_POLICY),
  violation("disable-comment.ts", "ts-builds/no-boundaries-disable"),
  violation("dynamic-import.ts", DENIED),
  violation("import-equals.cts", DENIED),
  violation("imports-test.ts", TEST_IMPORT),
  violation("reexport-star.ts", DENIED),
  violation("reexport.ts", NO_POLICY),
  violation("relative-across.ts", NO_POLICY),
  violation("require.cts", DENIED),
  violation("type-only.ts", DENIED),
  violation("types-only-value.ts", NO_POLICY),
  violation("undeclared-hoisted.ts", NO_POLICY),
  violation("undeclared-transitive.ts", NO_POLICY),
  violation("unknown-local.ts", NO_POLICY),
  violation("workspace-subpath.ts", NO_POLICY),
  violation("workspace.ts", NO_POLICY),
  `packages/shared/src/unresolved-local.ts:1 ${NO_POLICY}`,
]

export const DENY_MESSAGE = "@fx/rules (pure) denies imports of db-client, @ai/*, fs in its architecture policy"

/** A finding as `file:line rule (kind)`, telling deny, test-import and no-policy findings apart. */
export function describeFinding(finding: Finding): string {
  if (finding.rule !== "boundaries/dependencies") return `${finding.file}:${finding.line} ${finding.rule}`
  const kind =
    finding.message === DENY_MESSAGE
      ? DENIED
      : finding.message.endsWith("source files may not import test files")
        ? TEST_IMPORT
        : NO_POLICY
  return `${finding.file}:${finding.line} ${kind}`
}

// Warnings that mean a forced setting stopped working: the resolver listing several
// projects without noWarnOnMultipleProjects, and the plugin flagging deprecated options.
const STDERR_WARNINGS = ["Multiple projects found", "[boundaries][warning]"]

/**
 * Runs `lint.mjs` from `fixtureRoot` in a child process whose working directory is
 * `cwd`, relative to the fixture, and returns its findings. Throws on a non-zero exit or
 * on a warning that means a forced setting regressed.
 */
export function lintFixture(fixtureRoot: string, cwd: string, probe?: "--classify" | "--cwd-root"): Finding[] {
  const result = spawnSync(process.execPath, [join(fixtureRoot, "lint.mjs"), ...(probe === undefined ? [] : [probe])], {
    cwd: join(fixtureRoot, cwd),
    encoding: "utf-8",
  })
  if (result.status !== 0) throw new Error(`lint.mjs exited ${result.status}:\n${result.stderr}`)
  const warning = STDERR_WARNINGS.find((text) => result.stderr.includes(text))
  if (warning !== undefined) throw new Error(`lint.mjs warned "${warning}":\n${result.stderr}`)
  return JSON.parse(result.stdout) as Finding[]
}

/** A dependency-cruiser finding as `rule: from → to [via …]`, with package paths shortened. */
export type DepcruiseFinding = { rule: string; from: string; to: string; via: string[] }

const short = (path: string): string => path.replace(/^(.*\/)?node_modules\//, "")

export const describeDepcruise = (finding: DepcruiseFinding): string =>
  `${finding.rule}: ${finding.from} → ${short(finding.to)}${finding.via.length > 0 ? ` via ${finding.via.map(short).join(" → ")}` : ""}`

const RULES = "deny-reachable:@fx/rules"
const reach = (file: string, to: string, via: string[] = []): string =>
  `${RULES}: packages/rules/${file} → ${to}${via.length > 0 ? ` via ${via.join(" → ")}` : ""}`
const unresolved = (workspace: string, file: string, to: string): string =>
  `not-to-unresolvable:${workspace}: ${file} → ${to}`

/**
 * What dependency-cruiser must report on the fixture, ordered by rule and then file, as it
 * reports them. ESLint reports the one-hop deny cases too. The transitive ones only
 * dependency-cruiser can see: both `reaches-denied.ts` files (one in `src`, one in `test`)
 * through `@fx/types/runtime`, and `workspace-subpath.ts` through `@fx/shared/data`. The
 * unresolved `db-pool` imports are undeclared, so dependency-cruiser fails them as well as
 * ESLint. The type-only cycle in `packages/shared` must not appear.
 */
export const EXPECTED_DEPCRUISE = [
  reach("src/reaches-denied.ts", "db-client/index.js", ["packages/types/src/runtime.ts"]),
  reach("src/violations/denied-core.ts", "fs"),
  reach("src/violations/denied-declared.ts", "db-client/index.js"),
  reach("src/violations/denied-glob.ts", "@ai/openai/index.js"),
  reach("src/violations/denied-subpath.ts", "db-client/utils.js"),
  reach("src/violations/disable-comment.ts", "db-client/index.js"),
  reach("src/violations/dynamic-import.ts", "db-client/index.js"),
  reach("src/violations/import-equals.cts", "db-client/index.js"),
  reach("src/violations/reexport-star.ts", "db-client/index.js"),
  reach("src/violations/require.cts", "db-client/index.js"),
  reach("src/violations/type-only.ts", "db-client/index.js"),
  reach("src/violations/workspace-subpath.ts", "db-client/index.js", [
    "packages/shared/src/data.ts",
    "packages/db/src/index.ts",
  ]),
  reach("test/reaches-denied.ts", "db-client/index.js", ["packages/types/src/runtime.ts"]),
  "no-circular: packages/shared/src/cycle-a.ts → packages/shared/src/cycle-b.ts via packages/shared/src/cycle-a.ts",
  unresolved("@fx/api", "apps/api/src/undeclared.ts", "db-pool"),
  unresolved("@fx/rules", "packages/rules/src/violations/undeclared-transitive.ts", "db-pool"),
  unresolved("@fx/shared", "packages/shared/src/unresolved-local.ts", "./does-not-exist.ts"),
]

export type DepcruiseRun = { exitCode: number; violations: DepcruiseFinding[]; output: string }

/** Runs `depcruise.mjs` from `fixtureRoot` in a child process whose working directory is `cwd`. */
export function depcruiseFixture(fixtureRoot: string, cwd: string): DepcruiseRun {
  const result = spawnSync(process.execPath, [join(fixtureRoot, "depcruise.mjs")], {
    cwd: join(fixtureRoot, cwd),
    encoding: "utf-8",
  })
  if (result.status !== 0) throw new Error(`depcruise.mjs exited ${result.status}:\n${result.stderr}`)
  return JSON.parse(result.stdout) as DepcruiseRun
}
