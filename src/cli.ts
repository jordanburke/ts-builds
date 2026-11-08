import { runBuild, runDev, runFormat, runLint, runTest, runTypecheck } from "./cli/commands/build"
import { runChangelog } from "./cli/commands/changelog"
import { cleanup } from "./cli/commands/cleanup"
import { runDoctor } from "./cli/commands/doctor"
import { showHelp, showInfo } from "./cli/commands/info"
import { createConfig, init } from "./cli/commands/init"
import { runLintSummary } from "./cli/commands/lint-summary"
import { runSize } from "./cli/commands/size"
import { loadConfig } from "./cli/config"
import { runCommand } from "./cli/process"
import { builtinOverride, isBuiltinStepName, runConfiguredCommand, runValidate, stepName } from "./cli/runner"

const command = process.argv[2] || "init"
const subCommand = process.argv[3]

// A `commands` entry named after a built-in step replaces it here too, as it does in a chain.
// The config is read only for those commands, so help and init work without one.
const step = stepName(command, subCommand)
if (isBuiltinStepName(step)) {
  await builtinOverride(step, loadConfig()).fold(
    () => Promise.resolve(),
    async (cmd) => process.exit(await runConfiguredCommand(step, cmd)),
  )
}

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
  case "lint:summary":
    process.exit(await runLintSummary(process.argv.slice(3)))
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
    process.exit(await runBuild(true))
    break
  case "dev":
    process.exit(await runDev())
    break
  case "preview":
    process.exit(await runCommand("vite", ["preview"]))
    break
  case "validate":
    process.exit(await runValidate())
    break

  // Analysis commands
  case "size":
    process.exit(runSize(process.argv.slice(3)))
    break
  case "doctor":
    process.exit(runDoctor(subCommand === "--fix"))
    break
  case "changelog":
    process.exit(runChangelog(process.argv.slice(3)))
    break

  case "init":
    init()
    break
  case "config":
    createConfig(process.argv.includes("--force") || process.argv.includes("-f"))
    break

  default: {
    const config = loadConfig()
    if (config.chains[command]) {
      process.exit(await runValidate(command))
    } else if (config.commands[command]) {
      process.exit(await runConfiguredCommand(command, config.commands[command]))
    } else {
      console.error(`Unknown command: ${command}`)
      console.log("Run 'ts-builds help' for usage information.")
      process.exit(1)
    }
    break
  }
}
