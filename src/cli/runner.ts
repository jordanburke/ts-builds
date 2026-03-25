import { spawn } from "node:child_process"
import { join } from "node:path"

import type { CommandDef, ResolvedConfig } from "./config"
import { targetDir } from "./config"

export interface RunOptions {
  cwd?: string
}

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<number> {
  const cwd = options.cwd ? join(targetDir, options.cwd) : targetDir

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: true,
    })

    child.on("close", (code) => {
      resolve(code ?? 1)
    })

    child.on("error", (err) => {
      console.error(`Failed to run ${command}: ${err.message}`)
      resolve(1)
    })
  })
}

export function runShellCommand(shellCmd: string, options: RunOptions = {}): Promise<number> {
  const cwd = options.cwd ? join(targetDir, options.cwd) : targetDir

  return new Promise((resolve) => {
    const child = spawn(shellCmd, {
      cwd,
      stdio: "inherit",
      shell: true,
    })

    child.on("close", (code) => {
      resolve(code ?? 1)
    })

    child.on("error", (err) => {
      console.error(`Failed to run: ${err.message}`)
      resolve(1)
    })
  })
}

export async function runSequence(commands: Array<{ name: string; cmd: string; args: string[] }>): Promise<number> {
  for (const { name, cmd, args } of commands) {
    console.log(`\n▶ Running ${name}...`)
    const code = await runCommand(cmd, args)
    if (code !== 0) {
      console.error(`\n✗ ${name} failed with exit code ${code}`)
      return code
    }
    console.log(`✓ ${name} complete`)
  }
  return 0
}

export function getBuiltinCommands(config: ResolvedConfig): Record<string, CommandDef> {
  const eslintCmd = config.lint.useProjectEslint ? "npx eslint" : "eslint"

  const buildCmd =
    config.buildMode === "vite"
      ? { run: "rimraf dist && vite build" }
      : { run: "rimraf dist && cross-env NODE_ENV=production tsdown" }

  const buildWatchCmd = config.buildMode === "vite" ? { run: "vite build --watch" } : { run: "tsdown --watch" }

  const devCmd = config.buildMode === "vite" ? { run: "vite" } : { run: "tsdown --watch" }

  return {
    format: { run: "prettier --write ." },
    "format:check": { run: "prettier --check ." },
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

    const cmdDef = config.commands[step] ?? builtins[step]
    if (!cmdDef) {
      console.error(`Unknown command or chain: ${step}`)
      return 1
    }

    const cwdLabel = cmdDef.cwd ? ` (in ${cmdDef.cwd})` : ""
    console.log(`\n▶ Running ${step}...${cwdLabel}`)

    const code = await runShellCommand(cmdDef.run, { cwd: cmdDef.cwd })
    if (code !== 0) {
      console.error(`\n✗ ${step} failed with exit code ${code}`)
      return code
    }
    console.log(`✓ ${step} complete`)
  }

  return 0
}
