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
  lint: { useProjectEslint: boolean }
  size: SizeConfig
  changelog: ChangelogConfig
  commands: Record<string, CommandDef>
  chains: Record<string, string[]>
}

export const defaultChains: Record<string, string[]> = {
  validate: ["format", "lint", "typecheck", "test", "build"],
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

  return {
    srcDir: userConfig.srcDir ?? "./src",
    testDir: userConfig.testDir ?? "./test",
    buildMode: userConfig.buildMode ?? "tsdown",
    lint: {
      useProjectEslint: userConfig.lint?.useProjectEslint ?? false,
    },
    size: userConfig.size ?? {},
    changelog: userConfig.changelog ?? {},
    commands,
    chains,
  }
}
