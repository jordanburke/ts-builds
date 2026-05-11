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

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: resolveCwd(options.cwd),
      env: resolveEnv(options.env),
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
  return new Promise((resolve) => {
    const child = spawn(shellCmd, {
      cwd: resolveCwd(options.cwd),
      env: resolveEnv(options.env),
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
