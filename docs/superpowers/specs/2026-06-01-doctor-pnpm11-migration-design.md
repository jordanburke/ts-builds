# pnpm 11 Readiness Check + `doctor --fix` Migration — Design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Target release:** ts-builds 3.0.0 (bundled with the pnpm 11 migration)

## Goal

Give ts-builds consumers a first-class path through the pnpm 11 transition: `doctor` _detects_ the two config surfaces pnpm 11 silently ignores, and `doctor --fix` _migrates_ them to `pnpm-workspace.yaml`. Also declare ts-builds' Node floor via `engines`.

## Background

pnpm 11 changed where settings are read:

- `.npmrc` is **auth/registry only**. `public-hoist-pattern[]` lines are ignored.
- The `package.json` `pnpm` field (`overrides`, `peerDependencyRules`, …) is **no longer read**.
- Both must move to `pnpm-workspace.yaml` (which pnpm 10 and 11 both honor).

ts-builds 3.0.0's `init` already writes `publicHoistPattern` to `pnpm-workspace.yaml`. This feature handles the **upgrade** case: consumers who already have a `.npmrc` and/or a `package.json` `pnpm` field from before.

## Decisions (locked during brainstorming)

1. **Mutation model:** `doctor --fix` flag. Plain `doctor` stays read-only (mirrors `lint` / `lint:check`).
2. **Scope:** migrate **both** `.npmrc` hoist patterns **and** the `package.json` `pnpm` field.
3. **`engines`:** `node: ">=22"` only (no `engines.pnpm`).
4. **YAML strategy:** hand-roll known shapes, warn on the rest — **no new runtime dependency** (`yaml` is absent; `js-yaml` is only transitive via `eslint-config-functype` and must not be relied upon).

## Components

### 1. `engines` field

Add to `package.json`:

```json
"engines": {
  "node": ">=22"
}
```

Placed adjacent to the existing `packageManager` field. No enforcement code; this is published metadata.

### 2. New module: `src/cli/pnpm11.ts`

Keeps the already-large `doctor.ts` (244 lines) focused, and makes the logic unit-testable in isolation. Follows the repo's functype style (`List`, `Option`, `Fs` from `functype-os`). Exports:

```typescript
import { List } from "functype"

export type Severity = "error" | "warning" | "info"
export interface CheckResult {
  severity: Severity
  message: string
}

export interface MigrationAction {
  kind: "migrated" | "removed" | "skipped" | "manual"
  message: string
}
export interface MigrationReport {
  actions: List<MigrationAction>
  errors: number // count of failed writes / hard errors
}

// Read-only detection — consumed by doctor's report
export function detectPnpm11Issues(): List<CheckResult>

// Mutation — invoked by `doctor --fix`
export function migratePnpm11(): MigrationReport
```

Both operate on `targetDir` (imported from `../config`), matching `doctor.ts`.

The two known migratable shapes are defined once:

- `overrides` — a `Record<string, string>` (string → string map).
- `peerDependencyRules` — `{ allowedVersions?: Record<string,string>; ignoreMissing?: string[] }`.

Anything else under the `pnpm` field is treated as "exotic" (manual migration).

### 3. Detection — `detectPnpm11Issues()`

Inspects `targetDir`:

| Condition                                                                    | Result                                                                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `.npmrc` exists and contains a line matching `/^public-hoist-pattern\[\]=/m` | `warning`: `"N hoist pattern(s) in .npmrc are ignored by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml"`    |
| `package.json` has a `pnpm` field (non-empty object)                         | `warning`: `"package.json 'pnpm' field is no longer read by pnpm 11 — run 'ts-builds doctor --fix' to migrate to pnpm-workspace.yaml"` |
| neither                                                                      | `info`: `"pnpm 11 ready"`                                                                                                              |

`N` is the count of `public-hoist-pattern[]=` lines. Severity is `warning`, so plain `doctor` still exits 0 (warnings never fail; only `error` results do, per existing `runDoctor` logic).

### 4. Migration — `migratePnpm11()` (the `--fix` path)

Runs three steps, accumulating `MigrationAction`s. All writes preserve unrelated content.

**(a) `.npmrc` hoist patterns → `pnpm-workspace.yaml`**

1. Read `.npmrc`. Collect values from lines matching `/^public-hoist-pattern\[\]=(.+)$/`. Non-matching lines (auth, registry, blank, the header comment) are remembered for rewrite.
2. If any patterns found AND `pnpm-workspace.yaml` does **not** already contain `/^publicHoistPattern:/m`:
   - Append a `publicHoistPattern:` block using the same renderer shape as `init.ts`:
     ```yaml
     publicHoistPattern:
       - "<pattern>"
     ```
     with the separator rule from `init.ts` (insert a leading `\n` if the existing file doesn't end in one).
   - Action: `migrated` — `"Migrated N hoist pattern(s) to pnpm-workspace.yaml"`.
   - If `pnpm-workspace.yaml` already has `publicHoistPattern`: action `skipped` — `"publicHoistPattern already in pnpm-workspace.yaml — left .npmrc lines for manual review"` and do NOT strip `.npmrc` (avoid data loss when we didn't migrate).
3. When migration happened, rewrite `.npmrc` without the `public-hoist-pattern[]` lines (and drop the `# Hoist CLI tool binaries…` header if present). If the remaining content is empty or whitespace-only, delete the file (action `removed`: `"Removed empty .npmrc"`). Otherwise write back the preserved lines.

**(b) `package.json` `pnpm` field → `pnpm-workspace.yaml`**

1. Read and `JSON.parse` `package.json`. If no `pnpm` field, skip step (b).
2. For each known key present (`overrides`, `peerDependencyRules`):
   - If `pnpm-workspace.yaml` already has that top-level key (`/^<key>:/m`): action `skipped` — `"<key> already in pnpm-workspace.yaml — reconcile manually"`; leave it in the `pnpm` field.
   - Else: hand-serialize the known shape to YAML and append; remove the key from the `pnpm` field. Action `migrated` — `"Migrated pnpm.<key>"`.
3. For every other key under `pnpm` (e.g. `packageExtensions`, `patchedDependencies`, `onlyBuiltDependencies`): action `manual` — `"pnpm.<key> needs manual migration (left in package.json)"`. Leave in place.
4. If the `pnpm` field is now empty, remove it from `package.json`. Re-serialize `package.json` with 2-space indent + trailing newline (matching the repo's existing formatting) only if it changed.

**Hand-rolled YAML serializers** (in `pnpm11.ts`):

```yaml
# overrides
overrides:
  "<name>": "<range>"

# peerDependencyRules
peerDependencyRules:
  allowedVersions:
    "<name>": "<range>"
  ignoreMissing:
    - "<name>"
```

`allowedVersions` / `ignoreMissing` sub-keys are emitted only when present. Keys/values are emitted as double-quoted strings.

**(c) Report**

Print a `pnpm 11 migration` block listing each action with a glyph (`✓` migrated/removed, `!` manual/skipped). If `MigrationReport.errors > 0`, `runDoctor` returns a non-zero exit code.

### 5. `doctor.ts` integration

- `runDoctor(fix: boolean = false): Promise<number>`.
- Add `{ name: "pnpm 11 readiness", results: detectPnpm11Issues() }` to the `sections` list so detection always shows in the report.
- After printing sections (and before/with the summary), when `fix` is true: call `migratePnpm11()`, print its actions, and fold its `errors` into the exit-code decision (`errors > 0 ? 1 : 0`, combined with existing check errors).

### 6. CLI wiring — `src/cli.ts`

```typescript
case "doctor":
  process.exit(await runDoctor(subCommand === "--fix"))
  break
```

(`command = argv[2]`, `subCommand = argv[3]` already exist.)

### 7. Documentation

- `src/cli/commands/info.ts` (`showHelp`): add/clarify `doctor` and document `doctor --fix` (migrate `.npmrc` + `package.json` `pnpm` field to `pnpm-workspace.yaml`).
- `CLAUDE.md`: under CLI Usage / the pnpm 11 section, document `doctor --fix`.

## Data Flow

```
doctor [--fix]
  └─ runDoctor(fix)
       ├─ detectPnpm11Issues()  ──► CheckResult[] ──► printed in "pnpm 11 readiness" section
       └─ if fix:
            migratePnpm11()
              ├─ (a) .npmrc  ──read──► patterns ──► append publicHoistPattern to pnpm-workspace.yaml ──► rewrite/delete .npmrc
              ├─ (b) package.json.pnpm ──► append overrides/peerDependencyRules to pnpm-workspace.yaml ──► prune pnpm field
              └─ (c) MigrationReport ──► printed actions ──► exit code
```

## Error Handling

- No `package.json` in `targetDir`: existing `runDoctor` error path (`"No package.json found"`, exit 1). Migration not attempted.
- Unparseable / non-matching `.npmrc` lines: preserved verbatim on rewrite (never dropped).
- `pnpm-workspace.yaml` already contains a target key: `skipped` action + warning; never overwrite or merge into it (avoids corruption with the hand-rolled approach).
- File write failure: caught, recorded as a hard error in `MigrationReport.errors`, surfaced in the report, non-zero exit.
- Idempotency: a second `doctor --fix` finds nothing to migrate (no `public-hoist-pattern[]` lines, no `pnpm` field, or targets already present) → all `info`/no-op, exit 0.

## Testing (TDD)

**Unit — `detectPnpm11Issues` (new `test/pnpm11.spec.ts`, temp dirs):**

- `.npmrc` with patterns only → one warning, correct count.
- `package.json` `pnpm` field only → one warning.
- both → two warnings.
- neither → one info ("pnpm 11 ready").

**Integration — `doctor --fix` (extend `test/cli.spec.ts`, temp dirs, run built `dist/cli.js`):**

- temp dir with old `.npmrc` (hoist patterns) + `package.json` having `pnpm.overrides` + `pnpm.peerDependencyRules`:
  - after `doctor --fix`: `pnpm-workspace.yaml` contains `publicHoistPattern`, `overrides`, `peerDependencyRules`; `.npmrc` hoist lines gone (file removed if empty); `package.json` `pnpm` field removed.
- exotic key (`pnpm.packageExtensions`) → `manual` action reported, key retained in `package.json`, `pnpm` field NOT removed.
- pre-existing `publicHoistPattern` in `pnpm-workspace.yaml` → `skipped`, `.npmrc` left intact.
- idempotency: run `--fix` twice → second run no-ops, exit 0.
- plain `doctor` (no `--fix`) → reports warnings, writes nothing, exit 0.

## Out of Scope (YAGNI)

- Merging into existing `pnpm-workspace.yaml` keys (we skip + warn instead).
- Auto-migrating exotic `pnpm`-field keys (`packageExtensions`, `patchedDependencies`, etc.) — reported as manual.
- Comment preservation in `pnpm-workspace.yaml`.
- A standalone `migrate` command (folded into `doctor --fix`).
- `engines.pnpm`.
