import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { TsBuildsConfig } from "../config"
import { targetDir } from "../config"

const requiredHoistPatterns = [
  "public-hoist-pattern[]=*eslint*",
  "public-hoist-pattern[]=*prettier*",
  "public-hoist-pattern[]=*vitest*",
  "public-hoist-pattern[]=typescript",
  "public-hoist-pattern[]=*rimraf*",
  "public-hoist-pattern[]=*cross-env*",
]

export function ensureNpmrcHoistPatterns(): void {
  const npmrcPath = join(targetDir, ".npmrc")
  const existingContent = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf-8") : ""

  const missingPatterns = requiredHoistPatterns.filter((pattern) => !existingContent.includes(pattern))

  if (missingPatterns.length === 0) {
    return
  }

  const header = "# Hoist CLI tool binaries from peer dependencies"
  const hasHeader = existingContent.includes(header)

  let newContent = existingContent
  if (!hasHeader && missingPatterns.length > 0) {
    const separator =
      existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n\n" : existingContent.length > 0 ? "\n" : ""
    newContent = existingContent + separator + header + "\n"
  }

  for (const pattern of missingPatterns) {
    if (!newContent.endsWith("\n") && newContent.length > 0) {
      newContent += "\n"
    }
    newContent += pattern + "\n"
  }

  writeFileSync(npmrcPath, newContent)
  console.log(`✓ Updated .npmrc with ${missingPatterns.length} missing hoist pattern(s)`)
}

export function init(): void {
  console.log("Initializing ts-builds...")

  ensureNpmrcHoistPatterns()

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
    "docs": "pnpm docs:build",
    "subproject": { "run": "pnpm validate", "cwd": "./packages/sub" }
  },
  "chains": {
    "validate": ["format", "lint", "test", "build"],
    "validate:full": ["format", "lint", "typecheck", "test", "docs", "build"]
  }
}
`)
}
