import { runBuild, runFormat } from "./commands/build"
import type { CommandDef, ResolvedConfig } from "./config"
import { loadConfig } from "./config"
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

export function getBuiltinCommands(config: ResolvedConfig): Record<string, BuiltinCommand> {
  const eslintCmd = config.lint.useProjectEslint ? "npx eslint" : "eslint"

  const buildCmd: BuiltinCommand = {
    runFn: () => runBuild(false),
  }

  const buildWatchCmd: BuiltinCommand =
    config.buildMode === "vite" ? { run: "vite build --watch" } : { run: "tsdown --watch" }

  const devCmd: BuiltinCommand = config.buildMode === "vite" ? { run: "vite" } : { run: "tsdown --watch" }

  return {
    format: { runFn: () => runFormat(false) },
    "format:check": { runFn: () => runFormat(true) },
    lint: { run: `${eslintCmd} --fix ${config.srcDir}` },
    "lint:check": { run: `${eslintCmd} ${config.srcDir}` },
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
  visited = new Set<string>(),
): Promise<number> {
  if (visited.has(chainName)) {
    console.error(`Circular chain reference detected: ${chainName}`)
    return 1
  }
  visited.add(chainName)

  const chain = config.chains[chainName]
  if (!chain) {
    console.error(`Unknown chain: ${chainName}`)
    return 1
  }

  const builtins = getBuiltinCommands(config)

  console.log(`\n📋 Running chain: ${chainName} [${chain.join(" → ")}]`)

  for (const step of chain) {
    if (config.chains[step]) {
      const code = await runChain(step, config, visited)
      if (code !== 0) return code
      continue
    }

    const cmdDef: CommandDef | BuiltinCommand | undefined = config.commands[step] ?? builtins[step]
    if (!cmdDef) {
      console.error(`Unknown command or chain: ${step}`)
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
  }

  return 0
}

export async function runValidate(chainName = "validate"): Promise<number> {
  const config = loadConfig()
  return runChain(chainName, config)
}
