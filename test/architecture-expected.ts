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
// A local file in no element. The message names the target and the option that would allow it,
// and a test file's message names one more option than a source file's.
const OUTSIDE = "boundaries/dependencies (outside, source)"
const OUTSIDE_TEST = "boundaries/dependencies (outside, test)"
const UNRESOLVED_LOCAL = "boundaries/dependencies (unresolved local)"
const violation = (file: string, kind: string): string => `packages/rules/src/violations/${file}:1 ${kind}`

export const EXPECTED = [
  `apps/api/src/imports-other-own.ts:1 ${NO_POLICY}`,
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
  violation("root-file-in-src.ts", OUTSIDE),
  violation("type-only.ts", DENIED),
  violation("types-only-value.ts", NO_POLICY),
  violation("undeclared-hoisted.ts", NO_POLICY),
  violation("undeclared-transitive.ts", NO_POLICY),
  violation("unknown-local.ts", OUTSIDE),
  violation("unlisted-sibling.ts", OUTSIDE),
  violation("workspace-subpath.ts", NO_POLICY),
  violation("workspace.ts", NO_POLICY),
  `packages/rules/test/imports-nested-same-name.ts:1 ${OUTSIDE_TEST}`,
  `packages/rules/test/imports-unlisted-root.ts:1 ${OUTSIDE_TEST}`,
  `packages/shared/src/unresolved-local.ts:1 ${UNRESOLVED_LOCAL}`,
]

export const DENY_MESSAGE = "@fx/rules (pure) denies imports of db-client, @ai/*, fs in its architecture policy"

/** The kind of a `boundaries/dependencies` finding, from its message. */
function findingKind(message: string): string {
  if (message === DENY_MESSAGE) return DENIED
  if (message.endsWith("source files may not import test files")) return TEST_IMPORT
  if (message.endsWith("list it in testPolicy.allowRootFiles")) return OUTSIDE_TEST
  if (message.endsWith("list it in its ownDirs")) return OUTSIDE
  if (message.endsWith("a local path that doesn't resolve")) return UNRESOLVED_LOCAL
  return NO_POLICY
}

/** A finding as `file:line rule (kind)`, telling deny, test-import, outside and no-policy findings apart. */
export function describeFinding(finding: Finding): string {
  if (finding.rule !== "boundaries/dependencies") return `${finding.file}:${finding.line} ${finding.rule}`
  return `${finding.file}:${finding.line} ${findingKind(finding.message)}`
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
const ownDir = (check: string, file: string, to: string): string =>
  `own-dirs-${check}:@fx/rules: packages/rules/data/${file} → ${to}`

/**
 * What dependency-cruiser must report on the fixture, ordered by rule and then file, as it
 * reports them. ESLint reports the one-hop deny cases too. The transitive ones only
 * dependency-cruiser can see: both `reaches-denied.ts` files (one in `src`, one in `test`)
 * through `@fx/types/runtime`, and `workspace-subpath.ts` through `@fx/shared/data`. The
 * unresolved `db-pool` imports are undeclared, so dependency-cruiser fails them as well as
 * ESLint. The type-only cycle in `packages/shared` must not appear.
 *
 * `packages/rules/data` is an ownDirs folder, which ESLint doesn't lint: `reaches-denied-own.ts`
 * reaches `db-client` through it, and its other files are reported for what they import: an
 * unresolved alias, an undeclared package, a workspace outside `allow`, a second hop through a
 * local file in no element, a root file, its own test folder, and a test file in its own src.
 * `data/allowed.ts` and `data/core-ok.ts` import only what ownDirs code may, and the tests that
 * import the root `tooling.config.mjs` resolve, so none of them appears.
 */
export const EXPECTED_DEPCRUISE = [
  reach("src/reaches-denied-own.ts", "db-client/index.js", ["packages/rules/data/loader.ts"]),
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
  unresolved("@fx/rules", "packages/rules/data/broken.ts", "@lib/missing/thing"),
  unresolved("@fx/rules", "packages/rules/src/violations/undeclared-transitive.ts", "db-pool"),
  unresolved("@fx/shared", "packages/shared/src/unresolved-local.ts", "./does-not-exist.ts"),
  ownDir("boundary", "cross.ts", "packages/shared/src/index.ts"),
  ownDir("boundary", "hop-local.ts", "packages/rules/other/hop.ts"),
  ownDir("boundary", "hop-root.ts", "tooling.config.mjs"),
  ownDir("boundary", "hop-test.ts", "packages/rules/test/helpers.ts"),
  ownDir("test-file", "hop-src-test.ts", "packages/rules/src/colocated.test.ts"),
  ownDir("undeclared", "undeclared.ts", "test-runner/index.js"),
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
