import { spawn } from "node:child_process"
import { join } from "node:path"

import { targetDir } from "./config"

export interface RunOptions {
  cwd?: string
  /**
   * Environment variables to merge into `process.env` for the spawned child.
   * The parent process's env is preserved; only these keys are overlaid.
   * Use this instead of mutating `process.env` directly so the parent process
   * remains unchanged when these helpers are imported into long-lived runners.
   */
  env?: NodeJS.ProcessEnv
}

function resolveCwd(cwd?: string): string {
  return cwd ? join(targetDir, cwd) : targetDir
}

function resolveEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ? { ...process.env, ...env } : process.env
}

/** Spawn one shell command line; resolves with its exit code, or 1 if it can't start */
function spawnShell(commandLine: string, label: string, options: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(commandLine, {
      cwd: resolveCwd(options.cwd),
      env: resolveEnv(options.env),
      stdio: "inherit",
      shell: true,
    })

    child.on("close", (code) => {
      resolve(code ?? 1)
    })

    child.on("error", (err) => {
      console.error(`Failed to run${label}: ${err.message}`)
      resolve(1)
    })
  })
}

/**
 * Run `command` with `args` through the shell, so `.bin` shims (including
 * Windows `.cmd` files) and commands such as `npx eslint` resolve. `args` are
 * joined into the command line as given, not escaped: quote any argument that
 * holds spaces or shell characters, as `prettierFormatArgs` does. Joining here
 * rather than passing `args` to `spawn` gives the same command line Node built
 * before, without its DEP0190 warning, which flags exactly that unescaped join.
 */
export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<number> {
  return spawnShell([command, ...args].join(" "), ` ${command}`, options)
}

export function runShellCommand(shellCmd: string, options: RunOptions = {}): Promise<number> {
  return spawnShell(shellCmd, "", options)
}

export async function runSequence(commands: Array<{ name: string; cmd: string; args: string[] }>): Promise<number> {
  const [first, ...rest] = commands
  if (!first) return 0
  console.log(`\n▶ Running ${first.name}...`)
  const code = await runCommand(first.cmd, first.args)
  if (code !== 0) {
    console.error(`\n✗ ${first.name} failed with exit code ${code}`)
    return code
  }
  console.log(`✓ ${first.name} complete`)
  return runSequence(rest)
}
