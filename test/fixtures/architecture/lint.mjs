// Lints the fixture from the process's own working directory and prints every finding
// as JSON. test/architecture.spec.ts spawns it with different working directories.
//
//   --classify  Drop every policy, so each import reports how the plugin classified
//               its target. The spec snapshots that output.
//   --cwd-root  Set boundaries/root-path to the cwd, the plugin's default. Run from a
//               workspace, it must break: the spec's check that cwd really varies.
import { relative } from "node:path"

import { ESLint } from "eslint"
import { BOUNDARY_FILES } from "ts-builds/eslint-boundaries"

const probes = {
  "--classify": {
    files: [BOUNDARY_FILES],
    rules: {
      "boundaries/dependencies": [
        "error",
        { default: "disallow", checkAllOrigins: true, checkUnknownLocals: true, policies: [] },
      ],
    },
  },
  "--cwd-root": { files: [BOUNDARY_FILES], settings: { "boundaries/root-path": process.cwd() } },
}

const probe = process.argv[2]
const eslint = new ESLint(probe === undefined ? {} : { overrideConfig: probes[probe] })
const results = await eslint.lintFiles(["."])
const findings = results.flatMap((result) =>
  result.messages.map((message) => ({
    file: relative(import.meta.dirname, result.filePath)
      .split("\\")
      .join("/"),
    line: message.line,
    rule: message.ruleId ?? "fatal",
    message: message.message,
  })),
)
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))
process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`)
