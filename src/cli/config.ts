import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const targetDir = process.cwd()

export type BuildMode = "tsdown" | "vite"

export interface CommandDef {
  run: string
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

export function loadConfig(): ResolvedConfig {
  const configPath = join(targetDir, "ts-builds.config.json")
  let userConfig: TsBuildsConfig = {}

  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, "utf-8"))
    } catch {
      console.error("Warning: Failed to parse ts-builds.config.json, using defaults")
    }
  }

  const commands: Record<string, CommandDef> = {}
  if (userConfig.commands) {
    for (const [name, cmd] of Object.entries(userConfig.commands)) {
      commands[name] = typeof cmd === "string" ? { run: cmd } : cmd
    }
  }

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
