import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { Option } from "functype"

import type { Architecture } from "../../architecture"
import { runDepcruise } from "../../depcruise"

const DEFAULT_FILES = ["architecture.mjs", "architecture.js", "architecture.ts"]

/** The nearest `architecture.{mjs,js,ts}` at or above `dir`. */
function findArchitectureFile(dir: string): Option<string> {
  const found = DEFAULT_FILES.map((name) => join(dir, name)).find((path) => existsSync(path))
  if (found !== undefined) return Option(found)
  const parent = dirname(dir)
  return parent === dir ? Option.none<string>() : findArchitectureFile(parent)
}

const isArchitecture = (value: unknown): value is Architecture =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { rootDir?: unknown }).rootDir === "string" &&
  typeof (value as { workspaces?: unknown }).workspaces === "object" &&
  typeof (value as { testPolicy?: unknown }).testPolicy === "object"

/**
 * `ts-builds depcruise [file]`: loads the architecture a module default-exports (the
 * nearest `architecture.{mjs,js,ts}` when no file is given) and checks it with
 * dependency-cruiser. Returns 0 when clean, 1 on a violation, 2 when it couldn't check.
 */
export async function runDepcruiseCommand(file: string | undefined): Promise<number> {
  const path = file === undefined ? findArchitectureFile(process.cwd()) : Option(resolve(file))
  if (path.isNone()) {
    console.error(`No ${DEFAULT_FILES.join(", ")} found here or above. Pass the file: ts-builds depcruise <file>`)
    return 2
  }
  const modulePath = path.orThrow()
  const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: unknown }
  if (!isArchitecture(loaded.default)) {
    console.error(`${modulePath} must default-export defineArchitecture(...) from ts-builds/architecture.`)
    return 2
  }
  const report = await runDepcruise(loaded.default)
  if (report.exitCode === 2) {
    console.error(report.output)
    return 2
  }
  console.log(report.output)
  return report.exitCode
}
