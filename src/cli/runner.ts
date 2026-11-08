import { Option, Set } from "functype"

import { runBuild, runFormat, runLint } from "./commands/build"
import type { CommandDef, ResolvedConfig } from "./config"
import { escapingValidateCwdError, loadConfig } from "./config"
import { runShellCommand } from "./process"

export type { RunOptions } from "./process"
export { runCommand, runSequence, runShellCommand } from "./process"

/**
 * A chain step is either:
 *   - a `CommandDef` (shell-string `run`, optional `cwd`), or
 *   - an internal node-function step (`runFn`) used by builtins that need
 *     in-process behavior (e.g., the `build` builtin invokes `runBuild()`
 *     directly so dist cleanup and NODE_ENV setup go through the Node API
 *     instead of being shelled out).
 *
 * `runFn` is intentionally not exposed on `CommandDef` — user configs cannot
 * supply a runFn through ts-builds.config.json.
 */
export type RunFnCommand = { runFn: () => Promise<number> }
export type BuiltinCommand = CommandDef | RunFnCommand

/**
 * Type guard for the internal `runFn` step shape. A plain `"runFn" in cmd`
 * check leaves `cmd.runFn` typed `unknown` (CommandDef has no such key), so we
 * assert the narrowed type explicitly.
 */
function isRunFnCommand(cmd: CommandDef | RunFnCommand): cmd is RunFnCommand {
  return "runFn" in cmd
}

/** The built-in chain steps. A `commands` entry with one of these names replaces it, in a chain or run directly. */
export const BUILTIN_STEP_NAMES = [
  "format",
  "format:check",
  "lint",
  "lint:check",
  "typecheck",
  "ts-types",
  "test",
  "test:watch",
  "test:coverage",
  "test:ui",
  "build",
  "build:watch",
  "dev",
  "preview",
  "compile",
] as const

export type BuiltinStepName = (typeof BUILTIN_STEP_NAMES)[number]

export const isBuiltinStepName = (name: string): name is BuiltinStepName =>
  (BUILTIN_STEP_NAMES as readonly string[]).includes(name)

/** The step a top-level command runs: `lint check` is `lint:check`, `test watch` is `test:watch`, `test run` is `test` */
export function stepName(command: string, subCommand: string | undefined): string {
  if ((command === "lint" || command === "format") && subCommand === "check") return `${command}:check`
  if (command === "build" && subCommand === "watch") return "build:watch"
  if (command === "test" && (subCommand === "watch" || subCommand === "coverage" || subCommand === "ui")) {
    return `test:${subCommand}`
  }
  return command
}

/**
 * The user's replacement for a built-in step, if their config has one. Run directly, a built-in
 * resolves the same way it does inside a chain (`runStep`): `config.commands[step] ?? builtin`.
 */
export function builtinOverride(step: string, config: ResolvedConfig): Option<CommandDef> {
  return Option(config.commands[step]).filter(() => isBuiltinStepName(step))
}

/** Run a `commands` entry on its own: check its cwd, then run it through the shell */
export async function runConfiguredCommand(name: string, cmdDef: CommandDef): Promise<number> {
  const cwdError = escapingValidateCwdError(name, cmdDef)
  if (cwdError) {
    console.error(cwdError)
    return 1
  }
  return runShellCommand(cmdDef.run, { cwd: cmdDef.cwd })
}

export function getBuiltinCommands(config: ResolvedConfig): Record<string, BuiltinCommand> {
  const buildCmd: BuiltinCommand = {
    runFn: () => runBuild(false),
  }

  const buildWatchCmd: BuiltinCommand =
    config.buildMode === "vite" ? { run: "vite build --watch" } : { run: "tsdown --watch" }

  const devCmd: BuiltinCommand = config.buildMode === "vite" ? { run: "vite" } : { run: "tsdown --watch" }

  return {
    format: { runFn: () => runFormat(false) },
    "format:check": { runFn: () => runFormat(true) },
    lint: { runFn: () => runLint(false) },
    "lint:check": { runFn: () => runLint(true) },
    typecheck: { run: "tsc --noEmit" },
    "ts-types": { run: "tsc --noEmit" },
    test: { run: "vitest run" },
    "test:watch": { run: "vitest" },
    "test:coverage": { run: "vitest run --coverage" },
    "test:ui": { run: "vitest --ui" },
    build: buildCmd,
    "build:watch": buildWatchCmd,
    dev: devCmd,
    preview: { run: "vite preview" },
    compile: { run: "tsc" },
  }
}

export async function runChain(
  chainName: string,
  config: ResolvedConfig,
  path: Set<string> = Set.empty<string>(),
): Promise<number> {
  if (path.has(chainName)) {
    console.error(`Circular chain reference detected: ${chainName}`)
    return 1
  }

  const chain = config.chains[chainName]
  if (!chain) {
    console.error(`Unknown chain: ${chainName}`)
    return 1
  }

  console.log(`\n📋 Running chain: ${chainName} [${chain.join(" → ")}]`)

  return runSteps(chain, config, getBuiltinCommands(config), path.add(chainName))
}

async function runSteps(
  steps: string[],
  config: ResolvedConfig,
  builtins: Record<string, BuiltinCommand>,
  path: Set<string>,
): Promise<number> {
  const [step, ...rest] = steps
  if (step === undefined) return 0
  const code = await runStep(step, config, builtins, path)
  return code === 0 ? runSteps(rest, config, builtins, path) : code
}

async function runStep(
  step: string,
  config: ResolvedConfig,
  builtins: Record<string, BuiltinCommand>,
  path: Set<string>,
): Promise<number> {
  if (config.chains[step]) return runChain(step, config, path)

  const cmdDef: CommandDef | BuiltinCommand | undefined = config.commands[step] ?? builtins[step]
  if (!cmdDef) {
    console.error(`Unknown command or chain: ${step}`)
    return 1
  }

  const cwdError = isRunFnCommand(cmdDef) ? undefined : escapingValidateCwdError(step, cmdDef)
  if (cwdError) {
    console.error(cwdError)
    return 1
  }

  const cwdLabel = "cwd" in cmdDef && cmdDef.cwd ? ` (in ${cmdDef.cwd})` : ""
  console.log(`\n▶ Running ${step}...${cwdLabel}`)

  const code = isRunFnCommand(cmdDef) ? await cmdDef.runFn() : await runShellCommand(cmdDef.run, { cwd: cmdDef.cwd })
  if (code !== 0) {
    console.error(`\n✗ ${step} failed with exit code ${code}`)
    return code
  }
  console.log(`✓ ${step} complete`)
  return 0
}

export async function runValidate(chainName = "validate"): Promise<number> {
  const config = loadConfig()
  return runChain(chainName, config)
}
