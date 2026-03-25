import { loadConfig } from "../config"
import { runChain, runCommand } from "../runner"

export async function runFormat(check = false): Promise<number> {
  const args = check ? ["--check", "."] : ["--write", "."]
  return runCommand("prettier", args)
}

export async function runLint(check = false): Promise<number> {
  const config = loadConfig()
  const eslintCmd = config.lint.useProjectEslint ? "npx eslint" : "eslint"
  const args = check ? [config.srcDir] : ["--fix", config.srcDir]
  return runCommand(eslintCmd, args)
}

export async function runTypecheck(): Promise<number> {
  return runCommand("tsc", ["--noEmit"])
}

export async function runTest(mode: "run" | "watch" | "coverage" | "ui" = "run"): Promise<number> {
  switch (mode) {
    case "watch":
      return runCommand("vitest", [])
    case "coverage":
      return runCommand("vitest", ["run", "--coverage"])
    case "ui":
      return runCommand("vitest", ["--ui"])
    default:
      return runCommand("vitest", ["run"])
  }
}

export async function runBuild(watch = false): Promise<number> {
  const config = loadConfig()

  if (config.buildMode === "vite") {
    if (watch) return runCommand("vite", ["build", "--watch"])
    const cleanCode = await runCommand("rimraf", ["dist"])
    if (cleanCode !== 0) return cleanCode
    return runCommand("vite", ["build"])
  }

  if (watch) return runCommand("tsdown", ["--watch"])
  const cleanCode = await runCommand("rimraf", ["dist"])
  if (cleanCode !== 0) return cleanCode
  return runCommand("cross-env", ["NODE_ENV=production", "tsdown"])
}

export async function runDev(): Promise<number> {
  const config = loadConfig()
  return config.buildMode === "vite" ? runCommand("vite", []) : runCommand("tsdown", ["--watch"])
}

export async function runValidate(chainName = "validate"): Promise<number> {
  const config = loadConfig()
  return runChain(chainName, config)
}
