import { loadConfig } from "./cli/config"
import { runCommand, runShellCommand } from "./cli/runner"
import { runBuild, runDev, runFormat, runLint, runTest, runTypecheck, runValidate } from "./cli/commands/build"
import { runChangelog } from "./cli/commands/changelog"
import { cleanup } from "./cli/commands/cleanup"
import { runDoctor } from "./cli/commands/doctor"
import { showHelp, showInfo } from "./cli/commands/info"
import { createConfig, init } from "./cli/commands/init"
import { runSize } from "./cli/commands/size"

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
    process.exit(await runSize(process.argv.slice(3)))
    break
  case "doctor":
    process.exit(await runDoctor())
    break
  case "changelog":
    process.exit(await runChangelog(process.argv.slice(3)))
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
