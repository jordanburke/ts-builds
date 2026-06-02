# Doctor pnpm 11 Readiness + `--fix` Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pnpm 11 readiness check to `doctor` and a `doctor --fix` that migrates a consumer's `.npmrc` hoist patterns and `package.json` `pnpm` field into `pnpm-workspace.yaml`; also declare `engines.node`.

**Architecture:** A new dependency-free module `src/cli/pnpm11.ts` exports `detectPnpm11Issues(dir?)` (read-only, feeds `doctor`'s report) and `migratePnpm11(dir?)` (the `--fix` mutation, hand-rolling YAML for the known shapes and warning on the rest). `doctor.ts` adds a section + a `fix` parameter; `cli.ts` passes `--fix`.

**Tech Stack:** TypeScript (ESM, strict), functype (`List`), Vitest, node:fs. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-06-01-doctor-pnpm11-migration-design.md`

**Conventions observed:**

- Tests import source directly: `import { x } from "../src/cli/..."` and use `mkdtempSync` temp dirs (see `test/config.spec.ts`).
- CLI integration tests run the **built** `dist/cli.js` in a temp cwd (see `test/cli.spec.ts`) → those tests require `pnpm build` first.
- `detect`/`migrate` take an optional `dir = targetDir` (mirrors `cwdEscapesPackageRoot(cwd, baseDir)` in `config.ts`) so they're unit-testable without spawning the CLI.
- functype style: return `List<CheckResult>` for check results.
- `targetDir = process.cwd()` is exported from `src/cli/config.ts`.

---

## File Structure

| File                         | Responsibility                                                 | Action |
| ---------------------------- | -------------------------------------------------------------- | ------ |
| `package.json`               | Add `engines.node`                                             | Modify |
| `src/cli/pnpm11.ts`          | Detection + migration logic, YAML serializers, types           | Create |
| `src/cli/commands/doctor.ts` | Export `Severity`/`CheckResult`; add section; `runDoctor(fix)` | Modify |
| `src/cli.ts`                 | Pass `--fix` to `runDoctor`                                    | Modify |
| `src/cli/commands/info.ts`   | Help text for `doctor` / `doctor --fix`                        | Modify |
| `CLAUDE.md`                  | Document `doctor --fix`                                        | Modify |
| `test/pnpm11.spec.ts`        | Unit tests for detect + migrate                                | Create |
| `test/cli.spec.ts`           | CLI integration test for `doctor --fix`                        | Modify |

---

## Task 1: Add `engines.node`

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add the engines field**

In `package.json`, add an `engines` block adjacent to the `packageManager` field:

```json
  "engines": {
    "node": ">=22"
  },
```

Ensure valid JSON (trailing comma rules) — `packageManager` or another field follows it.

- [ ] **Step 2: Verify JSON validity**

Run: `node -e "const e=require('./package.json').engines; if(e?.node!=='>=22') throw new Error('engines.node not set'); console.log('engines OK:', e.node)"`
Expected: prints `engines OK: >=22`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: declare engines.node >=22"
```

---

## Task 2: `pnpm11.ts` — types + `detectPnpm11Issues` (TDD)

**Files:**

- Create: `src/cli/pnpm11.ts`
- Modify: `src/cli/commands/doctor.ts` (export the two types so `pnpm11.ts` can import them)
- Test: `test/pnpm11.spec.ts`

- [ ] **Step 1: Export the shared types from `doctor.ts`**

In `src/cli/commands/doctor.ts`, add `export` to the existing type/interface (currently lines 8-13):

```typescript
export type Severity = "error" | "warning" | "info"

export interface CheckResult {
  severity: Severity
  message: string
}
```

(Only add the `export` keywords; leave the rest of `doctor.ts` unchanged in this step.)

- [ ] **Step 2: Write the failing detection tests**

Create `test/pnpm11.spec.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { detectPnpm11Issues } from "../src/cli/pnpm11"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-pnpm11-"))
}

describe("detectPnpm11Issues", () => {
  it("warns about public-hoist-pattern lines in .npmrc with a count", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=typescript\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("2 hoist pattern(s) in .npmrc")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about a package.json pnpm field", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { a: "1" } } }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("package.json 'pnpm' field")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about both surfaces when both are present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { a: "1" } } }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.severity === "warning")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports ready when neither surface is present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const results = detectPnpm11Issues(dir).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("info")
      expect(results[0].message).toBe("pnpm 11 ready")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run test/pnpm11.spec.ts`
Expected: FAIL — `../src/cli/pnpm11` does not exist (import/module resolution error).

- [ ] **Step 4: Create `src/cli/pnpm11.ts` with types + detection**

Create `src/cli/pnpm11.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { List } from "functype"

import type { CheckResult } from "./commands/doctor"
import { targetDir } from "./config"

const HOIST_LINE = /^public-hoist-pattern\[\]=(.+)$/

function readHoistPatterns(npmrc: string): string[] {
  return npmrc
    .split("\n")
    .map((line) => HOIST_LINE.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1])
}

export function detectPnpm11Issues(dir: string = targetDir): List<CheckResult> {
  const results: CheckResult[] = []

  const npmrcPath = join(dir, ".npmrc")
  const npmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf-8") : ""
  const hoistCount = readHoistPatterns(npmrc).length
  if (hoistCount > 0) {
    results.push({
      severity: "warning",
      message: `${hoistCount} hoist pattern(s) in .npmrc are ignored by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml`,
    })
  }

  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pnpm?: Record<string, unknown> }
    if (pkg.pnpm && typeof pkg.pnpm === "object" && Object.keys(pkg.pnpm).length > 0) {
      results.push({
        severity: "warning",
        message: `package.json 'pnpm' field is no longer read by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml`,
      })
    }
  }

  if (results.length === 0) {
    results.push({ severity: "info", message: "pnpm 11 ready" })
  }

  return List(results)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/pnpm11.spec.ts`
Expected: PASS — all 4 detection tests green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/pnpm11.ts src/cli/commands/doctor.ts test/pnpm11.spec.ts
git commit -m "feat(doctor): detect pnpm 11 readiness issues"
```

---

## Task 3: `pnpm11.ts` — `migratePnpm11` + serializers (TDD)

**Files:**

- Modify: `src/cli/pnpm11.ts`
- Test: `test/pnpm11.spec.ts`

- [ ] **Step 1: Write the failing migration tests**

Append to `test/pnpm11.spec.ts` (the `migratePnpm11` import must be added to the existing import line: `import { detectPnpm11Issues, migratePnpm11 } from "../src/cli/pnpm11"`). Also add `readFileSync` and `existsSync` to the `node:fs` import at the top:

```typescript
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
```

Then add:

```typescript
describe("migratePnpm11", () => {
  it("migrates .npmrc hoist patterns to pnpm-workspace.yaml and removes the emptied .npmrc", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, ".npmrc"),
        "# Hoist CLI tool binaries from peer dependencies\npublic-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=typescript\n",
      )
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const report = migratePnpm11(dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("publicHoistPattern:")
      expect(ws).toContain(`  - "*eslint*"`)
      expect(ws).toContain(`  - "typescript"`)
      expect(existsSync(join(dir, ".npmrc"))).toBe(false)
      expect(report.actions.some((a) => a.kind === "migrated")).toBe(true)
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves non-hoist .npmrc lines", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "registry=https://example.com/\npublic-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      migratePnpm11(dir)
      const npmrc = readFileSync(join(dir, ".npmrc"), "utf-8")
      expect(npmrc).toContain("registry=https://example.com/")
      expect(npmrc).not.toContain("public-hoist-pattern")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("migrates known pnpm field keys and prunes the field", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          pnpm: { overrides: { foo: "1.0.0" }, peerDependencyRules: { allowedVersions: { eslint: "10" } } },
        }),
      )
      const report = migratePnpm11(dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("overrides:")
      expect(ws).toContain(`  "foo": "1.0.0"`)
      expect(ws).toContain("peerDependencyRules:")
      expect(ws).toContain("  allowedVersions:")
      expect(ws).toContain(`    "eslint": "10"`)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toBeUndefined()
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports exotic pnpm keys as manual and keeps them in package.json", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", pnpm: { overrides: { foo: "1" }, packageExtensions: { bar: {} } } }),
      )
      const report = migratePnpm11(dir)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toEqual({ packageExtensions: { bar: {} } })
      expect(report.actions.some((a) => a.kind === "manual" && a.message.includes("packageExtensions"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips when a target key already exists in pnpm-workspace.yaml and leaves .npmrc intact", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), `publicHoistPattern:\n  - "existing"\n`)
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const report = migratePnpm11(dir)
      expect(existsSync(join(dir, ".npmrc"))).toBe(true)
      expect(report.actions.some((a) => a.kind === "skipped")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent — a second run with nothing to migrate makes no changes", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      migratePnpm11(dir)
      const wsAfterFirst = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      const report2 = migratePnpm11(dir)
      const wsAfterSecond = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(wsAfterSecond).toBe(wsAfterFirst)
      expect(report2.actions.length).toBe(0)
      expect(report2.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the migration tests to verify they fail**

Run: `pnpm vitest run test/pnpm11.spec.ts -t migratePnpm11`
Expected: FAIL — `migratePnpm11` is not exported from `pnpm11.ts`.

- [ ] **Step 3: Implement `migratePnpm11` and serializers in `pnpm11.ts`**

Add to `src/cli/pnpm11.ts`. First extend the `node:fs` import to include `rmSync` and `writeFileSync`:

```typescript
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
```

Then append:

```typescript
export interface MigrationAction {
  kind: "migrated" | "removed" | "skipped" | "manual"
  message: string
}

export interface MigrationReport {
  actions: MigrationAction[]
  errors: number
}

interface PnpmField {
  overrides?: Record<string, string>
  peerDependencyRules?: {
    allowedVersions?: Record<string, string>
    ignoreMissing?: string[]
  }
  [key: string]: unknown
}

const NPMRC_HEADER = "# Hoist CLI tool binaries from peer dependencies"
const KNOWN_PNPM_KEYS = new Set(["overrides", "peerDependencyRules"])

function hasTopLevelKey(yaml: string, key: string): boolean {
  return new RegExp(`^${key}:`, "m").test(yaml)
}

function appendBlock(existing: string, block: string): string {
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  return existing + separator + block
}

function renderPublicHoistPattern(patterns: string[]): string {
  return "publicHoistPattern:\n" + patterns.map((p) => `  - "${p}"`).join("\n") + "\n"
}

function renderOverrides(overrides: Record<string, string>): string {
  return (
    "overrides:\n" +
    Object.entries(overrides)
      .map(([k, v]) => `  "${k}": "${v}"`)
      .join("\n") +
    "\n"
  )
}

function renderPeerDependencyRules(rules: NonNullable<PnpmField["peerDependencyRules"]>): string {
  const lines = ["peerDependencyRules:"]
  if (rules.allowedVersions && Object.keys(rules.allowedVersions).length > 0) {
    lines.push("  allowedVersions:")
    for (const [k, v] of Object.entries(rules.allowedVersions)) {
      lines.push(`    "${k}": "${v}"`)
    }
  }
  if (rules.ignoreMissing && rules.ignoreMissing.length > 0) {
    lines.push("  ignoreMissing:")
    for (const name of rules.ignoreMissing) {
      lines.push(`    - "${name}"`)
    }
  }
  return lines.join("\n") + "\n"
}

function safeWrite(path: string, content: string): boolean {
  try {
    writeFileSync(path, content)
    return true
  } catch {
    return false
  }
}

export function migratePnpm11(dir: string = targetDir): MigrationReport {
  const actions: MigrationAction[] = []
  let errors = 0

  const wsPath = join(dir, "pnpm-workspace.yaml")
  let ws = existsSync(wsPath) ? readFileSync(wsPath, "utf-8") : ""
  let wsChanged = false

  // (a) .npmrc hoist patterns -> pnpm-workspace.yaml
  const npmrcPath = join(dir, ".npmrc")
  if (existsSync(npmrcPath)) {
    const npmrc = readFileSync(npmrcPath, "utf-8")
    const patterns = readHoistPatterns(npmrc)
    if (patterns.length > 0) {
      if (hasTopLevelKey(ws, "publicHoistPattern")) {
        actions.push({
          kind: "skipped",
          message: "publicHoistPattern already in pnpm-workspace.yaml — left .npmrc lines for manual review",
        })
      } else {
        ws = appendBlock(ws, renderPublicHoistPattern(patterns))
        wsChanged = true
        actions.push({
          kind: "migrated",
          message: `Migrated ${patterns.length} hoist pattern(s) to pnpm-workspace.yaml`,
        })

        const remaining = npmrc
          .split("\n")
          .filter((line) => {
            const t = line.trim()
            return !HOIST_LINE.test(t) && t !== NPMRC_HEADER
          })
          .join("\n")

        if (remaining.trim() === "") {
          try {
            rmSync(npmrcPath)
            actions.push({ kind: "removed", message: "Removed empty .npmrc" })
          } catch {
            errors++
          }
        } else if (!safeWrite(npmrcPath, remaining.endsWith("\n") ? remaining : remaining + "\n")) {
          errors++
        }
      }
    }
  }

  // (b) package.json pnpm field -> pnpm-workspace.yaml
  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pnpm?: PnpmField; [k: string]: unknown }
    const pnpm = pkg.pnpm
    if (pnpm && typeof pnpm === "object") {
      let pkgChanged = false

      if (pnpm.overrides && Object.keys(pnpm.overrides).length > 0) {
        if (hasTopLevelKey(ws, "overrides")) {
          actions.push({ kind: "skipped", message: "overrides already in pnpm-workspace.yaml — reconcile manually" })
        } else {
          ws = appendBlock(ws, renderOverrides(pnpm.overrides))
          wsChanged = true
          delete pnpm.overrides
          pkgChanged = true
          actions.push({ kind: "migrated", message: "Migrated pnpm.overrides" })
        }
      }

      if (pnpm.peerDependencyRules && Object.keys(pnpm.peerDependencyRules).length > 0) {
        if (hasTopLevelKey(ws, "peerDependencyRules")) {
          actions.push({
            kind: "skipped",
            message: "peerDependencyRules already in pnpm-workspace.yaml — reconcile manually",
          })
        } else {
          ws = appendBlock(ws, renderPeerDependencyRules(pnpm.peerDependencyRules))
          wsChanged = true
          delete pnpm.peerDependencyRules
          pkgChanged = true
          actions.push({ kind: "migrated", message: "Migrated pnpm.peerDependencyRules" })
        }
      }

      for (const key of Object.keys(pnpm)) {
        if (!KNOWN_PNPM_KEYS.has(key)) {
          actions.push({ kind: "manual", message: `pnpm.${key} needs manual migration (left in package.json)` })
        }
      }

      if (Object.keys(pnpm).length === 0) {
        delete pkg.pnpm
        pkgChanged = true
      }

      if (pkgChanged && !safeWrite(pkgPath, JSON.stringify(pkg, null, 2) + "\n")) {
        errors++
      }
    }
  }

  if (wsChanged && !safeWrite(wsPath, ws)) {
    errors++
  }

  return { actions, errors }
}
```

- [ ] **Step 4: Run the migration tests to verify they pass**

Run: `pnpm vitest run test/pnpm11.spec.ts`
Expected: PASS — all detection + migration tests green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/pnpm11.ts test/pnpm11.spec.ts
git commit -m "feat(doctor): migrate .npmrc + pnpm field to pnpm-workspace.yaml"
```

---

## Task 4: Wire into `doctor` and `cli` (TDD integration)

**Files:**

- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/cli.ts`
- Test: `test/cli.spec.ts`

- [ ] **Step 1: Write the failing CLI integration test**

In `test/cli.spec.ts`, confirm the top `node:fs` import includes `existsSync`, `readFileSync`, `writeFileSync`, `rmSync`, `mkdtempSync` (add any missing). Then add this block:

```typescript
describe("doctor --fix pnpm 11 migration", () => {
  it("reports readiness in plain doctor and migrates with --fix", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0", pnpm: { overrides: { foo: "1.0.0" } } }, null, 2),
      )

      // plain doctor: reports, writes nothing
      const report = runCli(["doctor"], dir)
      expect(report).toContain("pnpm 11 readiness")
      expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false)

      // doctor --fix: migrates
      runCli(["doctor", "--fix"], dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("publicHoistPattern:")
      expect(ws).toContain("overrides:")
      expect(existsSync(join(dir, ".npmrc"))).toBe(false)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Note: `runCli` uses `execFileSync`, which throws on a non-zero exit code. `doctor` exits 0 here (warnings only, no migration errors), so the calls succeed.

- [ ] **Step 2: Build and run to verify failure**

Run: `pnpm build && pnpm vitest run test/cli.spec.ts -t "doctor --fix"`
Expected: FAIL — `doctor` does not yet print "pnpm 11 readiness" and `--fix` does not migrate (no `pnpm-workspace.yaml` produced).

- [ ] **Step 3: Wire `pnpm11` into `doctor.ts`**

In `src/cli/commands/doctor.ts`, add the import (after the existing imports):

```typescript
import { detectPnpm11Issues, migratePnpm11 } from "../pnpm11"
```

Change the `runDoctor` signature to accept `fix`:

```typescript
export async function runDoctor(fix = false): Promise<number> {
```

Add the detection section to the `sections` list (append after `Peer dependencies`):

```typescript
        { name: "Peer dependencies", results: checkPeerDeps(pkg) },
        { name: "pnpm 11 readiness", results: detectPnpm11Issues() },
```

After the `console.log(\`Summary: ...\`)`line and before the final`return`, insert the fix handling and fold migration errors into the exit code:

```typescript
let migrationErrors = 0
if (fix) {
  const migration = migratePnpm11()
  console.log("\nApplying pnpm 11 migration...")
  if (migration.actions.length === 0) {
    console.log("  + Nothing to migrate")
  } else {
    for (const action of migration.actions) {
      const glyph = action.kind === "migrated" || action.kind === "removed" ? "+" : "!"
      console.log(`  ${glyph} ${action.message}`)
    }
  }
  migrationErrors = migration.errors
  console.log()
}

return errors + migrationErrors > 0 ? 1 : 0
```

(Replace the existing final `return errors > 0 ? 1 : 0` with the block above.)

- [ ] **Step 4: Wire `--fix` into `cli.ts`**

In `src/cli.ts`, change the `doctor` case:

```typescript
  case "doctor":
    process.exit(await runDoctor(subCommand === "--fix"))
    break
```

- [ ] **Step 5: Build and run to verify the test passes**

Run: `pnpm build && pnpm vitest run test/cli.spec.ts`
Expected: PASS — the new `doctor --fix` test and all existing CLI tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts src/cli.ts test/cli.spec.ts
git commit -m "feat(doctor): wire pnpm 11 readiness + --fix into doctor and CLI"
```

---

## Task 5: Documentation

**Files:**

- Modify: `src/cli/commands/info.ts:50`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the `doctor` help line**

In `src/cli/commands/info.ts`, change line 50 from:

```
  doctor        Check package health (exports, files, types)
```

to:

```
  doctor        Check package health + pnpm 11 readiness (--fix migrates to pnpm-workspace.yaml)
```

- [ ] **Step 2: Document `doctor --fix` in CLAUDE.md**

In `CLAUDE.md`, in the `### pnpm 11` section (added earlier), append a paragraph:

```markdown
`ts-builds doctor` reports pnpm 11 readiness: it flags `public-hoist-pattern[]`
lines in `.npmrc` and a `package.json` `pnpm` field (both ignored by pnpm 11).
`ts-builds doctor --fix` migrates them to `pnpm-workspace.yaml` (`publicHoistPattern`,
`overrides`, `peerDependencyRules`), strips the inert `.npmrc` lines, and prunes the
`pnpm` field. Exotic `pnpm` keys (e.g. `packageExtensions`) and pre-existing target
keys are reported for manual migration rather than altered.
```

- [ ] **Step 3: Verify docs**

Run: `pnpm build && node dist/cli.js help | grep doctor`
Expected: shows the new `doctor` line mentioning `pnpm 11 readiness` / `--fix`.
Run: `grep -n "doctor --fix" CLAUDE.md`
Expected: at least one match.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/info.ts CLAUDE.md
git commit -m "docs: document doctor --fix pnpm 11 migration"
```

---

## Task 6: Full validation gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full validation under CI conditions**

Run: `CI=true pnpm validate:bootstrap`
Expected: format, lint, typecheck, test, build all pass; test count = previous total + 11 new (4 detect + 6 migrate in `pnpm11.spec.ts` + 1 CLI integration). (`CI=true` avoids the pnpm 11 no-TTY modules-purge prompt; see the pnpm 11 notes in CLAUDE.md.)

- [ ] **Step 2: Confirm no regressions in existing CLI behavior**

Run: `pnpm build && pnpm vitest run test/cli.spec.ts`
Expected: all CLI tests pass, including the prior `init`/`help`/`info`/bundle tests.

---

## Self-Review

**Spec coverage:**

- `engines.node: ">=22"` → Task 1. ✓
- `src/cli/pnpm11.ts` with `detectPnpm11Issues` + `migratePnpm11` → Tasks 2, 3. ✓
- Detection of `.npmrc` hoist + `package.json` pnpm field, info when ready → Task 2 tests + impl. ✓
- Migration (a) `.npmrc`→ws, strip/remove; (b) pnpm field overrides/peerDependencyRules→ws, prune; exotic→manual; skip-on-existing-key → Task 3 tests + impl. ✓
- `doctor` section + `runDoctor(fix)` + report + exit-code fold → Task 4. ✓
- `cli.ts` `--fix` wiring → Task 4. ✓
- Help text + CLAUDE.md → Task 5. ✓
- Error handling (safeWrite, errors count) → Task 3 impl (`safeWrite`, `errors`). ✓
- Idempotency, preserve non-hoist lines → Task 3 tests. ✓

**Placeholder scan:** YAML template tokens (`"<pattern>"` etc.) appear only inside serializer string templates, which are real code. No "TBD"/"add error handling"/"similar to". All code steps contain complete code.

**Type consistency:** `CheckResult`/`Severity` exported from `doctor.ts` (Task 2 Step 1), imported via `import type` in `pnpm11.ts` (Task 2 Step 4) — no runtime circular import. `detectPnpm11Issues(dir = targetDir): List<CheckResult>` and `migratePnpm11(dir = targetDir): MigrationReport` signatures match their call sites in `doctor.ts` (Task 4, called with no arg → defaults to `targetDir`). `MigrationAction.kind` union (`migrated|removed|skipped|manual`) matches the glyph switch in Task 4 Step 3 and the `.kind` assertions in Task 3 tests. `readHoistPatterns` defined in Task 2 is reused in Task 3's `migratePnpm11`. `HOIST_LINE` constant defined in Task 2, reused in Task 3. ✓
