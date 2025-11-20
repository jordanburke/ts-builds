#!/usr/bin/env node

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const templateDir = join(__dirname, "..", "templates")
const targetDir = process.cwd()

// Packages bundled with typescript-template-configs (users don't need these)
const bundledPackages = [
  "@eslint/eslintrc",
  "@eslint/js",
  "@types/node",
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/parser",
  "@vitest/coverage-v8",
  "@vitest/ui",
  "cross-env",
  "eslint",
  "eslint-config-prettier",
  "eslint-plugin-import",
  "eslint-plugin-prettier",
  "eslint-plugin-simple-import-sort",
  "globals",
  "prettier",
  "rimraf",
  "ts-node",
  "typescript",
  "vitest",
] as const

type BundledPackage = (typeof bundledPackages)[number]

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

const files = [{ src: "npmrc", dest: ".npmrc" }]

function showHelp(): void {
  console.log(`
typescript-template-configs - Shared TypeScript configuration files

USAGE:
  npx typescript-template-configs [command]

COMMANDS:
  init      Initialize project with config files (default)
  info      Show bundled packages you don't need to install
  cleanup   Remove redundant dependencies from package.json
  help      Show this help message

EXAMPLES:
  npx typescript-template-configs          # Initialize project
  npx typescript-template-configs info     # List bundled packages
  npx typescript-template-configs cleanup  # Remove redundant deps

DESCRIPTION:
  This package bundles all ESLint, Prettier, Vitest, and TypeScript
  tooling as dependencies. You only need to install:

  - typescript-template-configs (this package)
  - tsup (peer dependency for building)

  Run 'npx typescript-template-configs info' to see the full list
  of bundled packages.
`)
}

function showInfo(): void {
  console.log(`
typescript-template-configs bundles these packages:

You DON'T need to install:
${bundledPackages.map((pkg) => `  - ${pkg}`).join("\n")}

You ONLY need to install:
  - typescript-template-configs (this package)
  - tsup (peer dependency, optional)

Example minimal package.json devDependencies:
{
  "devDependencies": {
    "typescript-template-configs": "^3.0.0",
    "tsup": "^8.0.0"
  }
}
`)
}

async function cleanup(): Promise<void> {
  const packageJsonPath = join(targetDir, "package.json")

  if (!existsSync(packageJsonPath)) {
    console.error("Error: No package.json found in current directory")
    process.exit(1)
  }

  const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
  const devDeps = packageJson.devDependencies || {}
  const deps = packageJson.dependencies || {}

  const redundantDev = bundledPackages.filter((pkg): pkg is BundledPackage => pkg in devDeps)
  const redundantDeps = bundledPackages.filter((pkg): pkg is BundledPackage => pkg in deps)

  if (redundantDev.length === 0 && redundantDeps.length === 0) {
    console.log("✓ No redundant packages found. Your package.json is clean!")
    return
  }

  console.log("\nFound redundant packages that are bundled with typescript-template-configs:\n")

  if (redundantDev.length > 0) {
    console.log("devDependencies to remove:")
    redundantDev.forEach((pkg) => console.log(`  - ${pkg}`))
  }

  if (redundantDeps.length > 0) {
    console.log("\ndependencies to remove:")
    redundantDeps.forEach((pkg) => console.log(`  - ${pkg}`))
  }

  // Check for --yes flag
  const autoConfirm = process.argv.includes("--yes") || process.argv.includes("-y")

  if (!autoConfirm) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const answer = await new Promise<string>((resolve) => {
      rl.question("\nRemove these packages? (y/N) ", resolve)
    })
    rl.close()

    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Cancelled.")
      return
    }
  }

  // Remove redundant packages
  redundantDev.forEach((pkg) => delete devDeps[pkg])
  redundantDeps.forEach((pkg) => delete deps[pkg])

  // Update package.json
  if (Object.keys(devDeps).length > 0) {
    packageJson.devDependencies = devDeps
  } else {
    delete packageJson.devDependencies
  }

  if (Object.keys(deps).length > 0) {
    packageJson.dependencies = deps
  } else {
    delete packageJson.dependencies
  }

  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")

  const totalRemoved = redundantDev.length + redundantDeps.length
  console.log(`\n✓ Removed ${totalRemoved} redundant package(s) from package.json`)
  console.log("\nRun 'pnpm install' to update your lockfile.")
}

function init(): void {
  console.log("Initializing typescript-template-configs...")

  for (const { src: srcFile, dest: destFile } of files) {
    const src = join(templateDir, srcFile)
    const dest = join(targetDir, destFile)

    if (existsSync(dest)) {
      console.log(`  ⚠ ${destFile} already exists, skipping`)
    } else {
      copyFileSync(src, dest)
      console.log(`  ✓ Created ${destFile}`)
    }
  }

  console.log("\nDone! Your project is configured to hoist CLI binaries from peer dependencies.")
  console.log("\nNext steps:")
  console.log("  - Run 'npx typescript-template-configs info' to see bundled packages")
  console.log("  - Run 'npx typescript-template-configs cleanup' to remove redundant deps")
}

// Parse command
const command = process.argv[2] || "init"

switch (command) {
  case "help":
  case "--help":
  case "-h":
    showHelp()
    break
  case "info":
  case "--info":
    showInfo()
    break
  case "cleanup":
  case "--cleanup":
    await cleanup()
    break
  case "init":
  default:
    init()
    break
}
