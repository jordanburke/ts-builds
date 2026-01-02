import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const targetDir = process.cwd()

// ============================================================================
// Configuration
// ============================================================================

interface CommandDef {
  run: string
  cwd?: string
}

interface LintConfig {
  useProjectEslint?: boolean
}

interface TsBuildsConfig {
  srcDir?: string
  testDir?: string
  // Lint configuration
  lint?: LintConfig
  // Custom commands beyond built-ins
  commands?: Record<string, string | CommandDef>
  // Named chains - can reference built-ins, custom commands, or other chains
  chains?: Record<string, string[]>
  // Default validate chain (backward compat)
  validateChain?: string[]
}

interface ResolvedConfig {
  srcDir: string
  testDir: string
  lint: { useProjectEslint: boolean }
  commands: Record<string, CommandDef>
  chains: Record<string, string[]>
}

const defaultChains: Record<string, string[]> = {
  validate: ["format", "lint", "typecheck", "test", "build"],
}

function loadConfig(): ResolvedConfig {
  const configPath = join(targetDir, "ts-builds.config.json")
  let userConfig: TsBuildsConfig = {}

  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, "utf-8"))
    } catch {
      console.error("Warning: Failed to parse ts-builds.config.json, using defaults")
    }
  }

  // Normalize commands to CommandDef format
  const commands: Record<string, CommandDef> = {}
  if (userConfig.commands) {
    for (const [name, cmd] of Object.entries(userConfig.commands)) {
      commands[name] = typeof cmd === "string" ? { run: cmd } : cmd
    }
  }

  // Merge chains, with validateChain for backward compat
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
    lint: {
      useProjectEslint: userConfig.lint?.useProjectEslint ?? false,
    },
    commands,
    chains,
  }
}

// ============================================================================
// Command Runner
// ============================================================================

interface RunOptions {
  cwd?: string
}

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<number> {
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

function runShellCommand(shellCmd: string, options: RunOptions = {}): Promise<number> {
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

async function runSequence(commands: Array<{ name: string; cmd: string; args: string[] }>): Promise<number> {
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

// Packages bundled with ts-builds (users don't need these)
const bundledPackages = [
  "@eslint/eslintrc",
  "@eslint/js",
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

const requiredHoistPatterns = [
  "public-hoist-pattern[]=*eslint*",
  "public-hoist-pattern[]=*prettier*",
  "public-hoist-pattern[]=*vitest*",
  "public-hoist-pattern[]=typescript",
  "public-hoist-pattern[]=*rimraf*",
  "public-hoist-pattern[]=*cross-env*",
]

function ensureNpmrcHoistPatterns(): void {
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

function showHelp(): void {
  console.log(`
ts-builds - Shared TypeScript build tooling

USAGE:
  npx ts-builds [command]

SETUP COMMANDS:
  init      Initialize project with .npmrc hoist patterns (default)
  config    Create ts-builds.config.json (use --force to overwrite)
  info      Show bundled packages you don't need to install
  cleanup   Remove redundant dependencies from package.json
  help      Show this help message

SCRIPT COMMANDS:
  validate      Run full validation chain (configurable)
  format        Format code with Prettier (--write)
  format:check  Check formatting without writing
  lint          Lint and fix with ESLint
  lint:check    Check lint without fixing
  typecheck     Run TypeScript type checking (tsc --noEmit)
  test          Run tests once (vitest run)
  test:watch    Run tests in watch mode
  test:coverage Run tests with coverage
  test:ui       Launch Vitest UI
  build         Production build (rimraf dist && tsdown)
  build:watch   Watch mode build
  dev           Alias for build:watch

CONFIGURATION:
  Create ts-builds.config.json in your project root:

  Basic:
  {
    "srcDir": "./src",
    "validateChain": ["format", "lint", "typecheck", "test", "build"]
  }

  With custom ESLint plugins (e.g., eslint-plugin-functional):
  {
    "srcDir": "./src",
    "lint": {
      "useProjectEslint": true
    }
  }

  Advanced (monorepo with custom commands):
  {
    "srcDir": "./src",
    "commands": {
      "docs:validate": "pnpm docs:build && pnpm docs:check",
      "landing:validate": { "run": "pnpm validate", "cwd": "./landing" }
    },
    "chains": {
      "validate": ["validate:core", "validate:landing"],
      "validate:core": ["format", "lint", "compile", "test", "docs:validate", "build"],
      "validate:landing": ["landing:validate"]
    }
  }

USAGE IN PACKAGE.JSON:
  {
    "scripts": {
      "validate": "ts-builds validate",
      "validate:core": "ts-builds validate:core",
      "format": "ts-builds format",
      "lint": "ts-builds lint",
      "test": "ts-builds test",
      "build": "ts-builds build"
    }
  }

EXAMPLES:
  npx ts-builds validate       # Run default validation chain
  npx ts-builds validate:core  # Run named chain
  npx ts-builds lint           # Run single command
`)
}

function showInfo(): void {
  console.log(`
ts-builds bundles these packages:

You DON'T need to install:
${bundledPackages.map((pkg) => `  - ${pkg}`).join("\n")}

You ONLY need to install:
  - ts-builds (this package)
  - tsdown (peer dependency, optional)

Example minimal package.json devDependencies:
{
  "devDependencies": {
    "ts-builds": "^3.0.0",
    "tsdown": "^0.12.0"
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

  console.log("\nFound redundant packages that are bundled with ts-builds:\n")

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
  console.log("Initializing ts-builds...")

  ensureNpmrcHoistPatterns()

  console.log("\nDone! Your project is configured to hoist CLI binaries from peer dependencies.")
  console.log("\nNext steps:")
  console.log("  - Run 'npx ts-builds config' to create a config file")
  console.log("  - Run 'npx ts-builds info' to see bundled packages")
  console.log("  - Run 'npx ts-builds cleanup' to remove redundant deps")
}

function createConfig(force = false): void {
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

// ============================================================================
// Script Commands
// ============================================================================

async function runFormat(check = false): Promise<number> {
  const args = check ? ["--check", "."] : ["--write", "."]
  return runCommand("prettier", args)
}

async function runLint(check = false): Promise<number> {
  const config = loadConfig()
  const eslintCmd = config.lint.useProjectEslint ? "npx eslint" : "eslint"
  const args = check ? [config.srcDir] : ["--fix", config.srcDir]
  return runCommand(eslintCmd, args)
}

async function runTypecheck(): Promise<number> {
  return runCommand("tsc", ["--noEmit"])
}

async function runTest(mode: "run" | "watch" | "coverage" | "ui" = "run"): Promise<number> {
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

async function runBuild(watch = false): Promise<number> {
  if (watch) {
    return runCommand("tsdown", ["--watch"])
  }
  const cleanCode = await runCommand("rimraf", ["dist"])
  if (cleanCode !== 0) return cleanCode
  return runCommand("cross-env", ["NODE_ENV=production", "tsdown"])
}

// Built-in command definitions
function getBuiltinCommands(config: ResolvedConfig): Record<string, CommandDef> {
  const eslintCmd = config.lint.useProjectEslint ? "npx eslint" : "eslint"
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
    build: { run: "rimraf dist && cross-env NODE_ENV=production tsdown" },
    "build:watch": { run: "tsdown --watch" },
    dev: { run: "tsdown --watch" },
    compile: { run: "tsc" },
  }
}

async function runChain(chainName: string, config: ResolvedConfig, visited = new Set<string>()): Promise<number> {
  // Prevent infinite recursion
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
    // Check if step is another chain
    if (config.chains[step]) {
      const code = await runChain(step, config, visited)
      if (code !== 0) return code
      continue
    }

    // Check custom commands first, then builtins
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

async function runValidate(chainName = "validate"): Promise<number> {
  const config = loadConfig()
  return runChain(chainName, config)
}

// ============================================================================
// Main
// ============================================================================

// Parse command
const command = process.argv[2] || "init"

const subCommand = process.argv[3]

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

  // Script commands
  case "format":
    process.exit(await runFormat(subCommand === "check"))
    break
  case "format:check":
    process.exit(await runFormat(true))
    break
  case "lint":
    process.exit(await runLint(subCommand === "check"))
    break
  case "lint:check":
    process.exit(await runLint(true))
    break
  case "typecheck":
  case "ts-types":
    process.exit(await runTypecheck())
    break
  case "test":
    process.exit(await runTest(subCommand as "run" | "watch" | "coverage" | "ui" | undefined))
    break
  case "test:watch":
    process.exit(await runTest("watch"))
    break
  case "test:coverage":
    process.exit(await runTest("coverage"))
    break
  case "test:ui":
    process.exit(await runTest("ui"))
    break
  case "build":
    process.exit(await runBuild(subCommand === "watch"))
    break
  case "build:watch":
  case "dev":
    process.exit(await runBuild(true))
    break
  case "validate":
    process.exit(await runValidate())
    break

  case "init":
    init()
    break
  case "config":
    createConfig(process.argv.includes("--force") || process.argv.includes("-f"))
    break

  default: {
    // Check if it's a named chain (e.g., validate:core, validate:landing)
    const config = loadConfig()
    if (config.chains[command]) {
      process.exit(await runValidate(command))
    } else if (config.commands[command]) {
      // Run a custom command directly
      const cmdDef = config.commands[command]
      const code = await runShellCommand(cmdDef.run, { cwd: cmdDef.cwd })
      process.exit(code)
    } else {
      console.error(`Unknown command: ${command}`)
      console.log("Run 'ts-builds help' for usage information.")
      process.exit(1)
    }
    break
  }
}
