import { existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { Option } from "functype"

import type { Architecture } from "../../architecture"
import { runDepcruise } from "../../depcruise"

const DEFAULT_FILES: ReadonlyArray<string> = ["architecture.mjs", "architecture.js", "architecture.ts"]

const USAGE = `Usage: ts-builds depcruise [file]

Checks an architecture policy across the whole import graph with dependency-cruiser.
[file] is a module that default-exports defineArchitecture(...) from ts-builds/architecture.
Without it, the nearest ${DEFAULT_FILES.join(", ")} here or above is used.
Exits 0 when clean, 1 on a violation, 2 when it couldn't check.`

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()

/** The nearest `architecture.{mjs,js,ts}` file at or above `dir`. */
function findArchitectureFile(dir: string): Option<string> {
  const found = DEFAULT_FILES.map((name) => join(dir, name)).find(isFile)
  if (found !== undefined) return Option(found)
  const parent = dirname(dir)
  return parent === dir ? Option.none<string>() : findArchitectureFile(parent)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isArchitecture = (value: unknown): value is Architecture =>
  isObject(value) && typeof value.rootDir === "string" && isObject(value.workspaces) && isObject(value.testPolicy)

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The architecture a module default-exports, or why it couldn't be loaded. */
async function loadArchitecture(path: string): Promise<Architecture | string> {
  return import(pathToFileURL(path).href).then(
    (loaded: { default?: unknown }) =>
      isArchitecture(loaded.default)
        ? loaded.default
        : `${path} must default-export defineArchitecture(...) from ts-builds/architecture.`,
    // A policy that doesn't match the disk throws an ArchitectureError while loading.
    (error: unknown) => `Couldn't load ${path}:\n${message(error)}`,
  )
}

/**
 * `ts-builds depcruise [file]`: loads the architecture a module default-exports (the
 * nearest `architecture.{mjs,js,ts}` when no file is given) and checks it with
 * dependency-cruiser. Returns 0 when clean, 1 on a violation, 2 when it couldn't check.
 */
export async function runDepcruiseCommand(file: string | undefined): Promise<number> {
  if (file === "--help" || file === "-h") {
    console.log(USAGE)
    return 0
  }
  const path = file === undefined ? findArchitectureFile(process.cwd()) : Option(resolve(file)).filter(isFile)
  return path.fold(() => {
    console.error(
      file === undefined
        ? `No ${DEFAULT_FILES.join(", ")} found here or above. Pass the file: ts-builds depcruise <file>`
        : `${resolve(file)} is not a file.`,
    )
    return Promise.resolve(2)
  }, checkArchitectureFile)
}

async function checkArchitectureFile(path: string): Promise<number> {
  const loaded = await loadArchitecture(path)
  if (typeof loaded === "string") {
    console.error(loaded)
    return 2
  }
  const report = await runDepcruise(loaded)
  if (report.exitCode === 2) {
    console.error(report.output)
    return 2
  }
  console.log(report.output)
  return report.exitCode
}
