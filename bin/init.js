#!/usr/bin/env node

import { copyFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const templateDir = join(__dirname, "..", "templates")
const targetDir = process.cwd()

const files = [{ src: "npmrc", dest: ".npmrc" }]

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
