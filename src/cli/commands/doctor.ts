import { join } from "node:path"

import { List, Option } from "functype"
import { Fs } from "functype-os"

import { targetDir } from "../config"

type Severity = "error" | "warning" | "info"

interface CheckResult {
  severity: Severity
  message: string
}

interface PackageJson {
  name?: string
  version?: string
  license?: string
  description?: string
  repository?: unknown
  main?: string
  module?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: Record<string, unknown>
  files?: string[]
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

function resolveExportValue(value: unknown): List<string> {
  if (typeof value === "string") return List([value])
  if (typeof value === "object" && value !== null) {
    return List(Object.values(value)).flatMap((v) => resolveExportValue(v))
  }
  return List.empty()
}

function checkExports(pkg: PackageJson): List<CheckResult> {
  return Option(pkg.exports).fold(
    () => List<CheckResult>([{ severity: "info", message: "No exports field defined" }]),
    (exports) =>
      List(Object.entries(exports)).flatMap(([key, value]) =>
        resolveExportValue(value).map((p) => {
          const absPath = join(targetDir, p)
          return Fs.existsSync(absPath)
            ? { severity: "info" as Severity, message: `${key} -> ${p}` }
            : { severity: "error" as Severity, message: `${key} -> ${p} -- file not found` }
        }),
      ),
  )
}

function checkFiles(pkg: PackageJson): List<CheckResult> {
  return Option(pkg.files).fold(
    () =>
      List<CheckResult>([{ severity: "warning", message: "No files field defined -- npm will publish everything" }]),
    (files) =>
      List(files).map((entry) => {
        const absPath = join(targetDir, entry)
        if (!Fs.existsSync(absPath)) {
          return { severity: "warning" as Severity, message: `${entry} -- not found` }
        }
        return Fs.statSync(absPath).fold(
          () => ({ severity: "warning" as Severity, message: `${entry} -- cannot stat` }),
          (info) => ({
            severity: "info" as Severity,
            message: `${entry}${info.isDirectory ? "/" : ""}`,
          }),
        )
      }),
  )
}

function checkEntryPoints(pkg: PackageJson): List<CheckResult> {
  const fields = List([
    { name: "main", value: Option(pkg.main) },
    { name: "module", value: Option(pkg.module) },
    { name: "types", value: Option(pkg.types) },
  ])

  const fieldResults = fields.flatMap(({ name, value }) =>
    value.fold(
      () => List.empty<CheckResult>(),
      (v) => {
        const absPath = join(targetDir, v)
        return List([
          Fs.existsSync(absPath)
            ? { severity: "info" as Severity, message: `${name} -> ${v}` }
            : { severity: "error" as Severity, message: `${name} -> ${v} -- file not found` },
        ])
      },
    ),
  )

  const binResults = Option(pkg.bin).fold(
    () => List.empty<CheckResult>(),
    (bin) => {
      const bins = typeof bin === "string" ? { [pkg.name ?? "cli"]: bin } : bin
      return List(Object.entries(bins)).map(([name, path]) => {
        const absPath = join(targetDir, path)
        return Fs.existsSync(absPath)
          ? { severity: "info" as Severity, message: `bin.${name} -> ${path}` }
          : { severity: "error" as Severity, message: `bin.${name} -> ${path} -- file not found` }
      })
    },
  )

  return fieldResults.concat(binResults)
}

function checkDeclarations(distDir: string): List<CheckResult> {
  const absDir = join(targetDir, distDir)

  if (!Fs.existsSync(absDir)) {
    return List([{ severity: "warning" as Severity, message: `${distDir}/ directory not found` }])
  }

  return Fs.readdirSync(absDir).fold(
    () => List<CheckResult>([{ severity: "warning", message: `Cannot read ${distDir}/` }]),
    (entries) => {
      const allFiles = entries.flatMap((entry) => {
        const fullPath = join(absDir, entry)
        return Fs.statSync(fullPath).fold(
          () => List.empty<{ name: string; relPath: string }>(),
          (info) =>
            info.isFile
              ? List([{ name: entry, relPath: `${distDir}/${entry}` }])
              : List.empty<{ name: string; relPath: string }>(),
        )
      })

      const dtsFiles = allFiles
        .filter((f) => f.name.endsWith(".d.ts") || f.name.endsWith(".d.mts") || f.name.endsWith(".d.cts"))
        .map((f) => f.relPath.replace(/\.d\.(m?ts|cts)$/, ""))

      const jsFiles = allFiles.filter(
        (f) => f.name.endsWith(".js") || f.name.endsWith(".mjs") || f.name.endsWith(".cjs"),
      )

      const warnings = jsFiles.flatMap((jsFile) => {
        const base = jsFile.relPath.replace(/\.(m?js|cjs)$/, "")
        return dtsFiles.contains(base)
          ? List.empty<CheckResult>()
          : List<CheckResult>([{ severity: "warning", message: `${jsFile.relPath} has no matching .d.ts` }])
      })

      return warnings.isEmpty
        ? List<CheckResult>([{ severity: "info", message: `All ${jsFiles.size} JS files have declarations` }])
        : warnings
    },
  )
}

function checkRequiredFields(pkg: PackageJson): List<CheckResult> {
  const required = List([
    { field: "name" as const, severity: "error" as Severity },
    { field: "version" as const, severity: "error" as Severity },
    { field: "license" as const, severity: "warning" as Severity },
    { field: "description" as const, severity: "warning" as Severity },
    { field: "repository" as const, severity: "warning" as Severity },
  ])

  return required.map(({ field, severity }) =>
    Option(pkg[field]).fold(
      () => ({ severity, message: `${field} is missing` }),
      (value) => ({
        severity: "info" as Severity,
        message: `${field}: ${typeof value === "string" ? value : "defined"}`,
      }),
    ),
  )
}

function checkPeerDeps(pkg: PackageJson): List<CheckResult> {
  return Option(pkg.peerDependencies).fold(
    () => List.empty<CheckResult>(),
    (deps) =>
      List(Object.entries(deps)).map(([name, range]) => {
        const hasRange =
          range.startsWith("^") || range.startsWith(">=") || range.startsWith("~") || range.includes("||")
        return hasRange
          ? { severity: "info" as Severity, message: `${name}: "${range}"` }
          : { severity: "warning" as Severity, message: `${name}: "${range}" -- consider using a range (^, ~, >=)` }
      }),
  )
}

export async function runDoctor(): Promise<number> {
  const packageJsonPath = join(targetDir, "package.json")

  return Fs.readFileSync(packageJsonPath).fold(
    () => {
      console.error("No package.json found in current directory")
      return 1
    },
    (content) => {
      const pkg: PackageJson = JSON.parse(content)

      console.log("\nts-builds doctor\n")

      const sections = List([
        { name: "Required fields", results: checkRequiredFields(pkg) },
        { name: "Entry points", results: checkEntryPoints(pkg) },
        { name: "Exports", results: checkExports(pkg) },
        { name: "Files", results: checkFiles(pkg) },
        { name: "Declarations", results: checkDeclarations("dist") },
        { name: "Peer dependencies", results: checkPeerDeps(pkg) },
      ])

      let errors = 0
      let warnings = 0
      let passed = 0

      for (const section of sections) {
        if (section.results.isEmpty) continue

        console.log(`Checking ${section.name}...`)
        for (const result of section.results) {
          switch (result.severity) {
            case "error":
              console.log(`  x ${result.message}`)
              errors++
              break
            case "warning":
              console.log(`  ! ${result.message}`)
              warnings++
              break
            case "info":
              console.log(`  + ${result.message}`)
              passed++
              break
          }
        }
        console.log()
      }

      console.log(`Summary: ${errors} error(s), ${warnings} warning(s), ${passed} passed`)

      return errors > 0 ? 1 : 0
    },
  )
}
