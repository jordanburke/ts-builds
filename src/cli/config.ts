import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

export const targetDir = process.cwd()

/**
 * Returns true when `cwd` resolves outside `baseDir`. Used to reject the
 * removed cross-package sibling validate pattern (see CommandDef.cwd JSDoc
 * and issue #72). Exported for testing.
 */
export function cwdEscapesPackageRoot(cwd: string, baseDir: string = targetDir): boolean {
  const resolved = resolve(baseDir, cwd)
  const rel = relative(baseDir, resolved)
  if (rel === "") return false
  return rel.startsWith("..") || isAbsolute(rel)
}

/**
 * Returns an error message when a `validate:*` command's `cwd` escapes the
 * package root, or `undefined` when the command may run. Cross-package
 * validation through ts-builds chains was removed in 4.0 (issue #72).
 */
export function escapingValidateCwdError(name: string, cmd: CommandDef): string | undefined {
  if (!name.startsWith("validate:") || !cmd.cwd || !cwdEscapesPackageRoot(cmd.cwd)) return undefined
  return (
    `✗ commands[${JSON.stringify(name)}] uses cwd ${JSON.stringify(cmd.cwd)} which escapes the package root.\n` +
    `   ts-builds 4.0 no longer runs cross-package validation from a package's config.\n` +
    `   Use a workspace tool (Turbo, nx, pnpm -r) for monorepo orchestration.\n` +
    `   See: https://github.com/jordanburke/ts-builds/issues/72`
  )
}

export type BuildMode = "tsdown" | "vite"

export interface CommandDef {
  run: string
  /**
   * Working directory for the command, resolved relative to the package root.
   *
   * For commands keyed `validate:*`, a `cwd` that escapes the package root
   * (parent traversal or absolute path outside `targetDir`) is rejected when
   * the command runs (removed in ts-builds 4.0). Cross-package validation
   * should be orchestrated by a workspace tool (Turbo, nx, `pnpm -r`), not by
   * ts-builds chains.
   * See https://github.com/jordanburke/ts-builds/issues/72
   */
  cwd?: string
}

export interface LintConfig {
  useProjectEslint?: boolean
  /** Lint `testDir` as well as `srcDir`, when it exists. Off by default until 5.0. */
  includeTests?: boolean
}

export interface SizeConfig {
  maxTotal?: number
  maxFile?: number
  baselineFile?: string
  gzip?: boolean
}

export interface ChangelogConfig {
  types?: Record<string, string>
  exclude?: string[]
}

export interface TsBuildsConfig {
  srcDir?: string
  testDir?: string
  buildMode?: BuildMode
  lint?: LintConfig
  size?: SizeConfig
  changelog?: ChangelogConfig
  commands?: Record<string, string | CommandDef>
  chains?: Record<string, string[]>
  validateChain?: string[]
}

export interface ResolvedConfig {
  srcDir: string
  testDir: string
  buildMode: BuildMode
  lint: { useProjectEslint: boolean; includeTests: boolean }
  size: SizeConfig
  changelog: ChangelogConfig
  commands: Record<string, CommandDef>
  chains: Record<string, string[]>
  /** Why the derived `ci` chain can't be trusted, one message per cause; empty when it can. See `ciProblems`. */
  ciProblems: string[]
}

export const defaultChains: Record<string, string[]> = {
  validate: ["format", "lint", "typecheck", "test", "build"],
}

/** The built-in steps that rewrite files, each with the step that checks the same thing without writing. */
export const CHECK_TWINS: Readonly<Record<string, string>> = {
  format: "format:check",
  lint: "lint:check",
}

/**
 * The `ci` chain: `validate`'s steps with every step that rewrites files swapped for its check twin.
 *
 * `validate` makes the tree right on a developer's machine; CI has to prove the tree is right without
 * changing it. A check that runs after a fixer inspects an already-repaired tree and passes no matter
 * what was committed. Deriving `ci` from `validate`, instead of asking for a second list, keeps the two
 * from drifting: add `test` to `validate` and `ci` runs it too.
 *
 * A step that names another chain is derived the same way, inline. A chain already being expanded is
 * left as a reference, so `runChain` reports the cycle. Your own commands that aren't `format` or `lint`
 * run as written, so one that writes files still writes under `ci`; set `chains.ci` yourself in that case.
 */
export function deriveCiChain(
  chain: readonly string[],
  chains: Readonly<Record<string, string[]>>,
  expanding: readonly string[] = [],
): string[] {
  return chain.flatMap((step) => {
    const twin = CHECK_TWINS[step]
    if (twin !== undefined) return [twin]
    const nested = chains[step]
    if (nested === undefined || expanding.includes(step)) return [step]
    return deriveCiChain(nested, chains, [...expanding, step])
  })
}

/** The steps in `CHECK_TWINS` that `chain` reaches, directly or through nested chains. */
function writersReached(
  chain: readonly string[],
  chains: Readonly<Record<string, string[]>>,
  expanding: readonly string[] = [],
): string[] {
  return chain.flatMap((step) => {
    if (CHECK_TWINS[step] !== undefined) return [step]
    const nested = chains[step]
    if (nested === undefined || expanding.includes(step)) return []
    return writersReached(nested, chains, [...expanding, step])
  })
}

/**
 * Why the derived `ci` chain would check with a different tool than `validate` fixes with.
 *
 * A config that replaces `format` (a command or a chain) without replacing `format:check` would make
 * `ci` run ts-builds' own Prettier check against a project that formats with something else: a check of
 * the wrong thing, or a crash. Failing with the fix is better than either. The same goes for `lint`.
 */
export function ciProblems(
  validate: readonly string[],
  chains: Readonly<Record<string, string[]>>,
  commands: Readonly<Record<string, CommandDef>>,
): string[] {
  const replaced = (step: string): boolean => commands[step] !== undefined || chains[step] !== undefined
  return writersReached(validate, chains)
    .filter((writer, i, all) => all.indexOf(writer) === i)
    .filter((writer) => replaced(writer) && !replaced(CHECK_TWINS[writer] ?? writer))
    .map((writer) => {
      const twin = CHECK_TWINS[writer] ?? writer
      return (
        `✗ ts-builds ci can't check "${writer}": your config replaces "${writer}" but not "${twin}", so ci ` +
        `would run ts-builds' own ${twin} instead of your tool. Add a "${twin}" command, or set "chains.ci".`
      )
    })
}

function readUserConfig(configPath: string): TsBuildsConfig {
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"))
  } catch {
    console.error("Warning: Failed to parse ts-builds.config.json, using defaults")
    return {}
  }
}

export function loadConfig(): ResolvedConfig {
  const userConfig = readUserConfig(join(targetDir, "ts-builds.config.json"))

  const commands: Record<string, CommandDef> = Object.fromEntries(
    Object.entries(userConfig.commands ?? {}).map(([name, cmd]) => [
      name,
      typeof cmd === "string" ? { run: cmd } : cmd,
    ]),
  )

  const chains: Record<string, string[]> = { ...defaultChains }
  if (userConfig.validateChain) {
    chains.validate = userConfig.validateChain
  }
  if (userConfig.chains) {
    Object.assign(chains, userConfig.chains)
  }
  // Derived last, from the resolved `validate`, so `validateChain` and `chains.validate` both reach it.
  // A `chains.ci` or `commands.ci` of your own wins: chains shadow commands at the top level, so deriving
  // over a `commands.ci` would silently stop it running.
  const derivesCi = userConfig.chains?.ci === undefined && userConfig.commands?.ci === undefined
  if (derivesCi) {
    chains.ci = deriveCiChain(chains.validate ?? [], chains)
  }

  return {
    srcDir: userConfig.srcDir ?? "./src",
    testDir: userConfig.testDir ?? "./test",
    buildMode: userConfig.buildMode ?? "tsdown",
    lint: {
      useProjectEslint: userConfig.lint?.useProjectEslint ?? false,
      includeTests: userConfig.lint?.includeTests ?? false,
    },
    size: userConfig.size ?? {},
    changelog: userConfig.changelog ?? {},
    commands,
    chains,
    ciProblems: derivesCi ? ciProblems(chains.validate ?? [], chains, commands) : [],
  }
}
