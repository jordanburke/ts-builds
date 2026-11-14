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
