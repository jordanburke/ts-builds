# pnpm 11 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt pnpm 11 as ts-builds' own toolchain AND change the `init` CLI command to emit pnpm-11-compatible config, so the package works on pnpm 11 and keeps configuring consumers correctly.

**Architecture:** pnpm 11 makes `.npmrc` auth/registry-only and stops reading the `package.json` `pnpm` field; all non-auth settings move to `pnpm-workspace.yaml`. Two independent surfaces change: (1) the repo's own config (its `pnpm` field + root `.npmrc` hoist patterns relocate to a new `pnpm-workspace.yaml`; toolchain pin + CI Node floor bump), and (2) the consumer-facing `init` command (stops writing `public-hoist-pattern[]` to `.npmrc`, instead writes `publicHoistPattern` to `pnpm-workspace.yaml`, which pnpm 10 *and* 11 both honor).

**Tech Stack:** pnpm 11.x (via corepack), Node 24 (`.nvmrc`), tsdown, Vitest, TypeScript, GitHub Actions.

**Decisions locked in (from planning):**
1. Scope = **both** internal adoption + CLI output change.
2. `init` output = **`pnpm-workspace.yaml` only** (works on pnpm 10 & 11; drops pnpm ≤9 hoist support).
3. Strict defaults = **keep** `minimumReleaseAge` (1 day) and `strictDepBuilds` on; document the tradeoff.

**Verified facts (sources):**
- pnpm 11.0.0 requires **Node 22+**, is pure-ESM, bumps the **store to v11** (one-time re-fetch on first install). (github.com/pnpm/pnpm releases/tag/v11.0.0)
- In pnpm 11, **only auth/registry** settings are read from `.npmrc`; `publicHoistPattern`, `overrides`, `peerDependencyRules`, `minimumReleaseAge` go in `pnpm-workspace.yaml`. The `package.json` `pnpm` field is **no longer read**. (pnpm.io/settings)
- **pnpm 10 also reads** `pnpm-workspace.yaml` settings (`overrides`, `peerDependencyRules`, `publicHoistPattern`) — so a single `pnpm-workspace.yaml` serves both. (pnpm.io/10.x/settings)
- `pnpm-workspace.yaml`'s `packages` field is **optional**; omitting it includes only the root package. (pnpm.io/pnpm-workspace_yaml)
- YAML key is camelCase `publicHoistPattern` (vs `.npmrc`'s `public-hoist-pattern[]`).

**Current repo state (observed 2026-06-01):**
- `package.json:106-115` — `pnpm` field: `peerDependencyRules.allowedVersions.eslint = "10"`, `overrides.unrun = "0.2.37"`.
- `package.json:116` — `packageManager: pnpm@10.34.1+sha512…`.
- Root `.npmrc` — header comment + 6 `public-hoist-pattern[]` lines (`*eslint*`, `*prettier*`, `*vitest*`, `typescript`, `*rimraf*`, `*cross-env*`).
- `src/.npmrc` — same 6 patterns; **not** in `package.json` `files` (not published).
- `.nvmrc` = `v24` (already pnpm-11-compatible).
- `.github/workflows/node.js.yml` — `pnpm/action-setup@v4` (reads `packageManager`), Node matrix `[22.x]`.
- `.github/workflows/publish.yml` — `pnpm/action-setup@v4`, Node from `.nvmrc`, publishes via `npm publish --provenance` (NOT `pnpm publish` — unaffected by the pnpm-publish delegation removal).
- `src/cli/commands/init.ts` — `ensureNpmrcHoistPatterns()` writes 4 patterns to consumer `.npmrc`; `requiredHoistPatterns` array.
- `src/cli/config.ts` — `export const targetDir = process.cwd()`.
- `src/cli/commands/info.ts:26` — help line: `init  Initialize project with .npmrc hoist patterns (default)`.
- `test/cli.spec.ts` — `describe("init .npmrc generation")` with 3 tests asserting `.npmrc` output.
- `README.md:20,36,48` and `CLAUDE.md` — document `.npmrc` hoist patterns.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `pnpm-workspace.yaml` (root) | The repo's OWN pnpm settings: `overrides`, `peerDependencyRules`, `publicHoistPattern` | Create |
| `package.json` | Drop the `pnpm` field; bump `packageManager` to pnpm 11 | Modify |
| `.npmrc` (root) | Now empty (hoist patterns relocated) | Delete |
| `src/.npmrc` | Unpublished duplicate of hoist patterns | Delete |
| `.github/workflows/node.js.yml` | CI Node floor 22.x → 24.x | Modify |
| `src/cli/commands/init.ts` | Consumer `init`: write `pnpm-workspace.yaml` instead of `.npmrc` | Modify |
| `src/cli/commands/info.ts` | Help text for `init` | Modify |
| `test/cli.spec.ts` | Replace `.npmrc` assertions with `pnpm-workspace.yaml` assertions | Modify |
| `README.md`, `CLAUDE.md` | Doc updates for new `init` behavior + pnpm-11 notes | Modify |

The two phases are independent and each leaves the repo green: **Phase A** (Tasks 1–6) migrates the repo's own toolchain; **Phase B** (Tasks 7–10) changes the consumer-facing CLI. Phase B does not require Phase A.

---

## Phase A — Internal repo migration to pnpm 11

### Task 1: Relocate the repo's pnpm settings into `pnpm-workspace.yaml`

**Files:**
- Create: `pnpm-workspace.yaml`

- [ ] **Step 1: Create `pnpm-workspace.yaml` with the relocated settings**

Create `pnpm-workspace.yaml` (root) with exactly:

```yaml
overrides:
  unrun: "0.2.37"

peerDependencyRules:
  allowedVersions:
    eslint: "10"

publicHoistPattern:
  - "*eslint*"
  - "*prettier*"
  - "*vitest*"
  - "typescript"
  - "*rimraf*"
  - "*cross-env*"
```

(No `packages:` field — this is a single-package repo; omitting it scopes settings to the root package.)

- [ ] **Step 2: Verify pnpm still honors the settings (while on pnpm 10)**

Run: `pnpm install --no-frozen-lockfile && pnpm why eslint 2>/dev/null | head -5`
Expected: install completes; the `eslint` peer allowance and `unrun` override resolve exactly as before (no new peer-dependency warnings about eslint 10, lockfile unchanged for `unrun`).

Run: `git diff --stat pnpm-lock.yaml`
Expected: no changes to `pnpm-lock.yaml` (settings produce the same resolution as the old `pnpm` field + `.npmrc`).

- [ ] **Step 3: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(pnpm): relocate settings to pnpm-workspace.yaml"
```

---

### Task 2: Remove the deprecated config surfaces

**Files:**
- Modify: `package.json:106-115` (remove `pnpm` field)
- Delete: `.npmrc` (root)
- Delete: `src/.npmrc`

- [ ] **Step 1: Remove the `pnpm` field from `package.json`**

Delete these lines from `package.json` (currently lines 106–115):

```json
  "pnpm": {
    "peerDependencyRules": {
      "allowedVersions": {
        "eslint": "10"
      }
    },
    "overrides": {
      "unrun": "0.2.37"
    }
  },
```

Ensure the preceding line still ends with a comma and the JSON remains valid (the `packageManager` line follows).

- [ ] **Step 2: Delete the relocated `.npmrc` files**

Run:
```bash
git rm .npmrc src/.npmrc
```
Expected: both files staged for deletion. (Root `.npmrc` held only the header + 6 hoist patterns, now in `pnpm-workspace.yaml`; `src/.npmrc` was an unpublished duplicate.)

- [ ] **Step 3: Verify install + validate are unaffected (still on pnpm 10)**

Run: `pnpm install --no-frozen-lockfile && pnpm validate:bootstrap`
Expected: install clean, build complete, **92/92 tests pass** (test count may rise after Phase B). `git diff --stat pnpm-lock.yaml` shows no lockfile change.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(pnpm): drop package.json pnpm field and redundant .npmrc files"
```

---

### Task 3: Bump the toolchain to pnpm 11

**Files:**
- Modify: `package.json` (`packageManager` field, rewritten by corepack)

- [ ] **Step 1: Pin pnpm 11 via corepack**

Run: `corepack use pnpm@11`
Expected: rewrites `package.json`'s `packageManager` to `pnpm@11.x.y+sha512…` and reinstalls. Confirm with `pnpm --version` → `11.x.y`.

- [ ] **Step 2: Reinstall under pnpm 11 and inspect lockfile/store**

Run: `pnpm install --no-frozen-lockfile`
Expected: completes (one-time store v11 re-fetch is normal). Then `git diff pnpm-lock.yaml` — review any `lockfileVersion` or formatting changes. If the lockfile changed, that is expected and gets committed; if it did NOT change, also fine.

- [ ] **Step 3: Full validation under pnpm 11**

Run: `pnpm validate:bootstrap`
Expected: format + lint + typecheck + test + build all pass. If `strictDepBuilds: true` (new pnpm 11 default) fails the install on an un-approved build script, note which package and add an `allowBuilds` entry to `pnpm-workspace.yaml` in this step (do not silence by disabling the protection globally).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "chore(pnpm): bump toolchain to pnpm 11"
```

---

### Task 4: Raise the CI Node floor to 24

**Files:**
- Modify: `.github/workflows/node.js.yml:15` (matrix)

- [ ] **Step 1: Bump the Node matrix**

In `.github/workflows/node.js.yml`, change:

```yaml
    strategy:
      matrix:
        node-version: [22.x]
```

to:

```yaml
    strategy:
      matrix:
        node-version: [24.x]
```

(`publish.yml` already uses `node-version-file: ".nvmrc"` = v24, and `pnpm/action-setup@v4` in both workflows reads the `packageManager` field, so it auto-picks pnpm 11 — no other workflow edits needed.)

- [ ] **Step 2: Sanity-check the workflow locally**

Run: `node -e "const y=require('node:fs').readFileSync('.github/workflows/node.js.yml','utf8'); if(!y.includes('24.x')) throw new Error('matrix not bumped'); if(y.includes('22.x')) throw new Error('22.x still present'); console.log('matrix OK')"`
Expected: prints `matrix OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/node.js.yml
git commit -m "ci: raise Node floor to 24 for pnpm 11"
```

---

### Task 5: Document the strict-defaults tradeoff

**Files:**
- Modify: `CLAUDE.md` (Architecture / Build internals section)

- [ ] **Step 1: Add a pnpm-11 notes block to `CLAUDE.md`**

Under the `## Architecture` section's build notes in `CLAUDE.md`, add:

```markdown
### pnpm 11 (since <this version>)

This repo is pinned to pnpm 11 via `packageManager`. Settings live in
`pnpm-workspace.yaml`, NOT `.npmrc` (auth/registry only) or the `package.json`
`pnpm` field (no longer read by pnpm 11).

pnpm 11 secure defaults are left ON:
- `minimumReleaseAge` (1 day) — pnpm refuses dependency versions published less
  than 24h ago. CI installs from a committed `pnpm-lock.yaml`, so pinned versions
  are unaffected; this only bites a fresh `pnpm add` / lockfile re-resolution of a
  just-published package. To override locally for a one-off: `--config.minimumReleaseAge=0`.
- `strictDepBuilds` (true) — installs fail on un-approved dependency build scripts.
  Approve specific packages via `allowBuilds` in `pnpm-workspace.yaml`.
```

(Replace `<this version>` with the version being released — see Task 11.)

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note pnpm 11 settings location and strict defaults"
```

---

### Task 6: Verify the publish path under pnpm 11 (no code change expected)

**Files:** none (verification only)

- [ ] **Step 1: Confirm publish does not rely on `pnpm publish`**

Run: `grep -n "pnpm publish\|npm publish" .github/workflows/publish.yml`
Expected: only `npm publish --provenance --access public` appears. (pnpm 11 removed `pnpm publish`'s delegation to npm, but this repo never used it — no change required.)

- [ ] **Step 2: Confirm minimumReleaseAge will not block a frozen-lockfile CI install**

Run: `pnpm install --frozen-lockfile`
Expected: completes with no error. If pnpm 11 refuses any pinned dependency because it was published <24h ago, capture the package name; the mitigation is to wait or add a scoped `minimumReleaseAge` override in `pnpm-workspace.yaml` — record the finding rather than disabling the protection globally.

---

## Phase B — Consumer-facing `init` command

### Task 7: Switch `init` to emit `pnpm-workspace.yaml` (TDD)

**Files:**
- Modify: `src/cli/commands/init.ts`
- Test: `test/cli.spec.ts` (replace the `init .npmrc generation` block)

- [ ] **Step 1: Replace the `.npmrc` test block with `pnpm-workspace.yaml` tests**

In `test/cli.spec.ts`, delete the entire `describe("init .npmrc generation", () => { … })` block and replace it with:

```typescript
describe("init pnpm-workspace.yaml generation", () => {
  it("produces the expected publicHoistPattern list", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("publicHoistPattern:")
      expect(ws).toContain(`  - "*eslint*"`)
      expect(ws).toContain(`  - "*prettier*"`)
      expect(ws).toContain(`  - "*vitest*"`)
      expect(ws).toContain(`  - "typescript"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent — running init twice does not duplicate the block", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      const firstRun = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      runCli([], dir)
      const secondRun = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(secondRun).toBe(firstRun)
      expect(secondRun.split("publicHoistPattern:").length - 1).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves pre-existing pnpm-workspace.yaml content", () => {
    const dir = makeTempDir()
    try {
      const existing = "packages:\n  - \"packages/*\"\n"
      writeFileSync(join(dir, "pnpm-workspace.yaml"), existing)
      runCli([], dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain(`packages:`)
      expect(ws).toContain(`  - "packages/*"`)
      expect(ws).toContain("publicHoistPattern:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not create a .npmrc", () => {
    const dir = makeTempDir()
    try {
      runCli([], dir)
      expect(existsSync(join(dir, ".npmrc"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Add `existsSync` and `writeFileSync` to the existing `node:fs` import at the top of the file if not already present:

```typescript
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm build && pnpm vitest run test/cli.spec.ts -t "pnpm-workspace.yaml generation"`
Expected: FAIL — `init` still writes `.npmrc`, so `pnpm-workspace.yaml` is missing and the `.npmrc` file exists. (Build is required because the test executes `dist/cli.js`.)

- [ ] **Step 3: Rewrite `init.ts` to emit `pnpm-workspace.yaml`**

In `src/cli/commands/init.ts`, replace the `requiredHoistPatterns` array and the `ensureNpmrcHoistPatterns` function with:

```typescript
const hoistPatterns = ["*eslint*", "*prettier*", "*vitest*", "typescript"]

function renderHoistBlock(): string {
  return "publicHoistPattern:\n" + hoistPatterns.map((p) => `  - "${p}"`).join("\n") + "\n"
}

export function ensureWorkspaceHoistPatterns(): void {
  const wsPath = join(targetDir, "pnpm-workspace.yaml")
  const existing = existsSync(wsPath) ? readFileSync(wsPath, "utf-8") : ""

  if (existing.includes("publicHoistPattern")) {
    return
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  const newContent = existing + separator + renderHoistBlock()

  writeFileSync(wsPath, newContent)
  console.log(`✓ Updated pnpm-workspace.yaml with publicHoistPattern (${hoistPatterns.length} patterns)`)
}
```

Then update the `init()` function body: replace the `ensureNpmrcHoistPatterns()` call with `ensureWorkspaceHoistPatterns()`, and update the trailing log line:

```typescript
export function init(): void {
  console.log("Initializing ts-builds...")

  ensureWorkspaceHoistPatterns()

  console.log("\nDone! Your project is configured to hoist CLI binaries from peer dependencies.")
  console.log("\nNext steps:")
  console.log("  - Run 'npx ts-builds config' to create a config file")
  console.log("  - Run 'npx ts-builds info' to see bundled packages")
  console.log("  - Run 'npx ts-builds cleanup' to remove redundant deps")
}
```

The existing `node:fs` import in `init.ts` (`existsSync, readFileSync, writeFileSync`) already covers what's needed — no import change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm build && pnpm vitest run test/cli.spec.ts`
Expected: PASS — all CLI tests green, including the new `pnpm-workspace.yaml generation` block and the unchanged help/info/bundle tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts test/cli.spec.ts
git commit -m "feat(cli): init writes pnpm-workspace.yaml instead of .npmrc"
```

---

### Task 8: Update the `init` help text

**Files:**
- Modify: `src/cli/commands/info.ts:26`

- [ ] **Step 1: Update the help line**

In `src/cli/commands/info.ts`, change line 26 from:

```
  init      Initialize project with .npmrc hoist patterns (default)
```

to:

```
  init      Initialize project with pnpm-workspace.yaml hoist patterns (default)
```

- [ ] **Step 2: Verify help output**

Run: `pnpm build && node dist/cli.js help | grep init`
Expected: shows `pnpm-workspace.yaml hoist patterns`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/info.ts
git commit -m "docs(cli): update init help text for pnpm-workspace.yaml"
```

---

### Task 9: Update README and CLAUDE.md for the new `init` behavior

**Files:**
- Modify: `README.md` (lines referencing `.npmrc`, currently 20, 36, 48)
- Modify: `CLAUDE.md` (CLI Usage / init description)

- [ ] **Step 1: Update README references**

In `README.md`, replace each `.npmrc` reference with the `pnpm-workspace.yaml` equivalent. The three known lines:

- `npx ts-builds init      # Creates .npmrc with hoist patterns` → `npx ts-builds init      # Creates pnpm-workspace.yaml with hoist patterns`
- `npx ts-builds init      # Creates .npmrc` → `npx ts-builds init      # Creates pnpm-workspace.yaml`
- `npx ts-builds init           # Create .npmrc with hoist patterns` → `npx ts-builds init           # Create pnpm-workspace.yaml with hoist patterns`

Run first to confirm no other occurrences slipped in: `grep -n "npmrc\|hoist" README.md`

- [ ] **Step 2: Update CLAUDE.md CLI description**

In `CLAUDE.md`, under "CLI Usage" / "CLI Architecture", update any `init (default)` description and the `## CLI Usage` comment block that says init creates `.npmrc` to instead say it creates/updates `pnpm-workspace.yaml` with `publicHoistPattern`. Confirm scope first: `grep -n "npmrc\|hoist\|init " CLAUDE.md`

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update init docs for pnpm-workspace.yaml output"
```

---

### Task 10: Full validation gate

**Files:** none (verification only)

- [ ] **Step 1: Run the complete validation chain under pnpm 11**

Run: `pnpm validate:bootstrap`
Expected: format ✓, lint ✓, typecheck ✓, test ✓ (all CLI tests including new block), build ✓.

- [ ] **Step 2: Grep for any stale `.npmrc`/`public-hoist-pattern` references**

Run: `grep -rn "public-hoist-pattern\|ensureNpmrcHoistPatterns\|\.npmrc" src/ test/ README.md CLAUDE.md`
Expected: no matches for `public-hoist-pattern[]`, `ensureNpmrcHoistPatterns`, or stale `.npmrc` generation references. (References to `.npmrc` purely as "auth/registry only" in docs are acceptable; flag and review any others.)

---

### Task 11: Release

**Files:**
- Modify: `package.json` (`version`)

- [ ] **Step 1: Bump version**

This is a behavior change to the `init` CLI output. Choose a **minor** bump (e.g. `2.8.2` → `2.9.0`) since consumers re-running `init` get a different file. Update `package.json` `version`.

- [ ] **Step 2: Backfill the version in CLAUDE.md**

Replace `<this version>` in the Task 5 pnpm-11 notes block with the chosen version.

- [ ] **Step 3: Commit, tag, push**

```bash
git add package.json CLAUDE.md
git commit -m "chore: release X.Y.0 (pnpm 11 migration)"
git push origin main
git tag -a vX.Y.0 -m "vX.Y.0" && git push origin vX.Y.0
```

- [ ] **Step 4: Watch the publish workflow**

Run: `gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status`
Expected: validate ✓, publish ✓, GitHub Release ✓. Confirm `npm view ts-builds version` shows the new version.

---

## Self-Review

**Spec coverage:**
- Decision 1 (both scopes) → Phase A (Tasks 1–6) + Phase B (Tasks 7–10). ✓
- Decision 2 (`pnpm-workspace.yaml` only for init) → Task 7 (no `.npmrc` written; test asserts its absence). ✓
- Decision 3 (keep strict defaults, document) → Task 3 Step 3 (handle via `allowBuilds`, not disable), Task 5 (docs), Task 6 (verify CI install). ✓
- Repo `pnpm` field relocation → Task 1 + Task 2. ✓
- Root `.npmrc` + `src/.npmrc` removal → Task 2. ✓
- Toolchain pin → Task 3. ✓ Node floor → Task 4. ✓
- Publish path unaffected → Task 6 verifies. ✓
- Docs (README, CLAUDE.md, help text) → Tasks 8, 9. ✓

**Placeholder scan:** `<this version>` / `X.Y.0` in Tasks 5/11 are intentional release-time values, resolved within the plan (Task 11 Steps 1–2). No "TBD"/"add error handling"/"similar to" placeholders. All code steps include full code.

**Type consistency:** New function `ensureWorkspaceHoistPatterns()` is defined in Task 7 Step 3 and called in the same `init()` body; the test block (Step 1) asserts the exact strings the implementation emits (`publicHoistPattern:`, `  - "*eslint*"`, etc.). `hoistPatterns` array (4 entries) matches the four `expect(...).toContain` assertions. `renderHoistBlock()` output format (`  - "<pattern>"`) matches test expectations. ✓
