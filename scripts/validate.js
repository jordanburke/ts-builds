#!/usr/bin/env node

/**
 * Validation script for typescript-template-configs package
 * Ensures all config files are present, valid, and package is ready to publish
 */

const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")

let errors = []
let warnings = []

function log(message, type = "info") {
  const prefix = {
    info: "ℹ",
    success: "✓",
    error: "✗",
    warning: "⚠",
  }[type]

  console.log(`${prefix} ${message}`)
}

function checkFileExists(filePath, description) {
  if (fs.existsSync(filePath)) {
    log(`${description} exists`, "success")
    return true
  } else {
    errors.push(`${description} not found: ${filePath}`)
    log(`${description} not found: ${filePath}`, "error")
    return false
  }
}

function validateJSON(filePath, description) {
  try {
    const content = fs.readFileSync(filePath, "utf8")
    JSON.parse(content)
    log(`${description} is valid JSON`, "success")
    return true
  } catch (e) {
    errors.push(`${description} has invalid JSON: ${e.message}`)
    log(`${description} has invalid JSON: ${e.message}`, "error")
    return false
  }
}

function main() {
  console.log("\n📦 Validating typescript-template-configs package...\n")

  // Check package.json exists
  const packageJsonPath = path.join(process.cwd(), "package.json")
  if (!checkFileExists(packageJsonPath, "package.json")) {
    process.exit(1)
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))

  // Validate package.json
  console.log("\n1️⃣  Validating package.json...")
  validateJSON(packageJsonPath, "package.json")

  if (!packageJson.name) {
    errors.push("package.json missing 'name' field")
    log("Missing 'name' field", "error")
  }

  if (!packageJson.version) {
    errors.push("package.json missing 'version' field")
    log("Missing 'version' field", "error")
  }

  if (!packageJson.exports) {
    errors.push("package.json missing 'exports' field")
    log("Missing 'exports' field", "error")
  }

  // Check all exported files exist
  console.log("\n2️⃣  Checking exported config files...")
  if (packageJson.exports) {
    Object.entries(packageJson.exports).forEach(([key, value]) => {
      if (key === "./package.json") return // Skip package.json export

      const filePath = value.replace("./", "")
      checkFileExists(filePath, `Export '${key}'`)
    })
  }

  // Validate JSON config files
  console.log("\n3️⃣  Validating JSON config files...")
  const jsonFiles = [
    "tsconfig.base.json",
    "package-scripts.json",
  ]

  jsonFiles.forEach((file) => {
    if (fs.existsSync(file)) {
      validateJSON(file, file)
    }
  })

  // Check files array matches actual files
  console.log("\n4️⃣  Verifying files array...")
  if (packageJson.files) {
    packageJson.files.forEach((file) => {
      checkFileExists(file, `File '${file}'`)
    })
  }

  // Test npm pack
  console.log("\n5️⃣  Testing npm pack...")
  try {
    execSync("npm pack --dry-run", { stdio: "pipe" })
    log("npm pack dry-run succeeded", "success")
  } catch (e) {
    errors.push("npm pack dry-run failed")
    log("npm pack dry-run failed", "error")
  }

  // Check for required config files
  console.log("\n6️⃣  Checking required config files...")
  const requiredFiles = [
    "prettier-config.js",
    ".prettierignore",
    "eslint.config.base.mjs",
    "dist/vitest.config.base.js",
    "dist/tsup.config.base.js",
    "tsconfig.base.json",
    "package-scripts.json",
    "README.md",
    "LICENSE",
  ]

  requiredFiles.forEach((file) => {
    checkFileExists(file, file)
  })

  // Check peer dependencies
  console.log("\n7️⃣  Checking peer dependencies...")
  if (!packageJson.peerDependencies) {
    warnings.push("No peerDependencies defined")
    log("No peerDependencies defined", "warning")
  } else {
    log(`Found ${Object.keys(packageJson.peerDependencies).length} peer dependencies`, "success")
  }

  // Summary
  console.log("\n" + "=".repeat(50))
  console.log("\n📊 Validation Summary\n")

  if (errors.length === 0 && warnings.length === 0) {
    log("All checks passed! Package is ready to publish.", "success")
    console.log("")
    process.exit(0)
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  Warnings (${warnings.length}):\n`)
    warnings.forEach((warning) => console.log(`  - ${warning}`))
  }

  if (errors.length > 0) {
    console.log(`\n❌ Errors (${errors.length}):\n`)
    errors.forEach((error) => console.log(`  - ${error}`))
    console.log("\n❌ Validation failed. Please fix the errors above.\n")
    process.exit(1)
  }

  if (warnings.length > 0 && errors.length === 0) {
    console.log("\n✅ Validation passed with warnings.\n")
    process.exit(0)
  }
}

main()
