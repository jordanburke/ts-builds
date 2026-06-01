import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { TsBuildsConfig } from "../config"
import { targetDir } from "../config"

const hoistPatterns = ["*eslint*", "*prettier*", "*vitest*", "typescript"]

function renderHoistBlock(): string {
  return "publicHoistPattern:\n" + hoistPatterns.map((p) => `  - "${p}"`).join("\n") + "\n"
}

export function ensureWorkspaceHoistPatterns(): void {
  const wsPath = join(targetDir, "pnpm-workspace.yaml")
  const existing = existsSync(wsPath) ? readFileSync(wsPath, "utf-8") : ""

  if (existing.includes("publicHoistPattern")) {
    return
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  const newContent = existing + separator + renderHoistBlock()

  writeFileSync(wsPath, newContent)
  console.log(`✓ Updated pnpm-workspace.yaml with publicHoistPattern (${hoistPatterns.length} patterns)`)
}

export function init(): void {
  console.log("Initializing ts-builds...")

  ensureWorkspaceHoistPatterns()

  console.log("\nDone! Your project is configured to hoist CLI binaries from peer dependencies.")
  console.log("\nNext steps:")
  console.log("  - Run 'npx ts-builds config' to create a config file")
  console.log("  - Run 'npx ts-builds info' to see bundled packages")
  console.log("  - Run 'npx ts-builds cleanup' to remove redundant deps")
}

export function createConfig(force = false): void {
  const configPath = join(targetDir, "ts-builds.config.json")

  if (existsSync(configPath) && !force) {
    console.log("ts-builds.config.json already exists.")
    console.log("Use 'ts-builds config --force' to overwrite.")
    return
  }

  const defaultConfig: TsBuildsConfig = {
    srcDir: "./src",
    validateChain: ["format", "lint", "typecheck", "test", "build"],
  }

  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n")
  console.log("✓ Created ts-builds.config.json")
  console.log(`
Configuration options:
  srcDir         Source directory for linting (default: "./src")
  testDir        Test directory (default: "./test")
  buildMode      "tsdown" (default, libraries) or "vite" (SPAs/React apps)
  lint           Lint settings: { "useProjectEslint": true }
  validateChain  Commands to run for validate (default shown above)
  commands       Custom commands: { "name": "shell command" }
  chains         Named chains: { "validate:fast": ["format", "lint"] }

Example with custom ESLint plugins:
{
  "srcDir": "./src",
  "lint": {
    "useProjectEslint": true
  }
}

Example with custom commands:
{
  "srcDir": "./src",
  "commands": {
    "docs": "pnpm docs:build"
  },
  "chains": {
    "validate": ["format", "lint", "test", "build"],
    "validate:full": ["format", "lint", "typecheck", "test", "docs", "build"]
  }
}

For cross-package orchestration in a monorepo, use Turbo, nx, or
\`pnpm -r\` rather than ts-builds chains with cwd-escaping commands.
`)
}
