import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { targetDir } from "../config"
import type { BundledPackage } from "./info"
import { bundledPackages } from "./info"

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

export async function cleanup(): Promise<void> {
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

  redundantDev.forEach((pkg) => delete devDeps[pkg])
  redundantDeps.forEach((pkg) => delete deps[pkg])

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
