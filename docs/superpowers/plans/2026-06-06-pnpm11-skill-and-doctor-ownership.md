# pnpm 11 Knowledge Ownership: Skill Sync + Doctor Guidance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ts-builds the single source of truth for the pnpm 11 migration story. Two surfaces are out of sync with the 3.0.0 reality: (A) the **agent-facing skill** (`SKILL.md` + `references/`) still teaches pre-3.0.0 `.npmrc` behavior and says nothing about pnpm 11's on-by-default supply-chain settings; (B) `doctor` automates only the *mechanical* part of the migration (hoist patterns + `pnpm` field) and gives no guidance on the two parts that actually require judgment — `minimumReleaseAge` violations and the `allowBuilds` / ignored-builds decision.

**Why now:** A real envpkt migration (2026-06-06) exercised the full 2.8.2→3.0.0 / pnpm 10→11 path. The mechanical relocation (`doctor --fix`) worked perfectly, but the agent began the session with **stale skill guidance** (believed `init` writes `.npmrc`) and had to hand-resolve the `minimumReleaseAge` exclude (`@types/node@24.13.1`, no aged alternative in range) and the `allowBuilds.esbuild: false` decision with no tool support. Those gaps are reproducible for every consumer.

**Tech Stack:** TypeScript, tsdown, Vitest, functype, Commander CLI, Claude Code plugin/skill (`.claude/skills/ts-builds/`). No MCP server (ts-builds is CLI + skill only).

## Verified facts (sources)

- pnpm 11 enables **supply-chain protection by default**: `minimumReleaseAge` defaults to **1440** (1 day), `blockExoticSubdeps: true`, `strictDepBuilds: true`, `optimisticRepeatInstall: true`, `verifyDepsBeforeRun: install`. (pnpm.io blog releases/11.0 — "Supply-chain protection on by default" + "Breaking changes > Security & build defaults")
- `pnpm config get minimumReleaseAge` returns `undefined` even though the policy is active — it is a **built-in default, not an explicit setting**. (observed in envpkt migration; install failed `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`)
- `allowBuilds` (added v10.26.0) **replaces** `onlyBuiltDependencies` / `onlyBuiltDependenciesFile` / `neverBuiltDependencies` / `ignoredBuiltDependencies` / `ignoreDepScripts` in v11. It is a map of package matcher → boolean in `pnpm-workspace.yaml`. (pnpm.io settings + releases/11.0)
- Ignored build scripts are a **hard error** (`ERR_PNPM_IGNORED_BUILDS`) under `strictDepBuilds: true`, not pnpm 10's soft warning. (observed)
- `esbuild`'s build script is **not needed** — its binary ships via `@esbuild/<platform>` optional deps; `allowBuilds.esbuild: false` is correct (verified by a green build). (observed)
- `corepack use pnpm@11` aborts the reinstall with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` in non-interactive shells (store-v11 re-fetch purges `node_modules`); re-run install with `CI=true`. Lockfile stays `lockfileVersion: 9.0`. (observed)
- `minimumReleaseAgeExclude` accepts pinned `pkg@version` and bare `pkg` (all versions); when a dep's semver range has no aged-enough version (e.g. `@types/node@^24.13.1`), a pinned exclude is the correct fix, not a downgrade. (pnpm.io releases/10.19 + observed)

## Current state (observed 2026-06-06)

- `SKILL.md:39,59,75` — three `npx ts-builds init # Creates .npmrc with hoist patterns` lines (stale; 3.0.0 writes `pnpm-workspace.yaml`).
- `.claude/skills/ts-builds/references/standardization.md:17`, `template-setup.md:35`, `tooling-reference.md:13` — same stale `.npmrc` init comment.
- `SKILL.md` + all three `references/*.md` — **0** mentions of pnpm 11 / `minimumReleaseAge` / `allowBuilds` / `pnpm-workspace.yaml`.
- `README.md` (3 mentions) and `CLAUDE.md` (14 mentions) — already updated for pnpm 11; treat as the canonical prose to mirror into the skill.
- `src/cli/pnpm11.ts` — `detectPnpm11Issues()` checks only `.npmrc` hoist patterns (`pnpm11.ts:24-28`) + `package.json` `pnpm` field (`:38`); `migratePnpm11()` relocates hoist patterns / overrides / peerDependencyRules only (`:135,:151`). No `minimumReleaseAge` or ignored-builds awareness.
- `src/cli/commands/doctor.ts:210` wires `detectPnpm11Issues()`; `:245` runs `migratePnpm11()` on `--fix`.

## Non-goals

- Re-documenting pnpm 11 in `README.md` / `CLAUDE.md` (already done).
- Building an MCP server.
- Changing the existing hoist-pattern / `pnpm`-field migration behavior (it works).

---

## Phase A — Sync the agent-facing skill (doc-only, low risk)

### Task A1: De-stale the `.npmrc` references

- [ ] Replace the 6 `init ... .npmrc` lines (`SKILL.md:39,59,75`; `standardization.md:17`; `template-setup.md:35`; `tooling-reference.md:13`) with the 3.0.0 reality: `init` writes `pnpm-workspace.yaml` (`publicHoistPattern`); `.npmrc` is auth/registry-only under pnpm 11.
- [ ] Grep-verify zero remaining stale references: `grep -rn "\.npmrc\|public-hoist-pattern" .claude/skills/` returns only intentional auth/registry mentions.

### Task A2: Add a "pnpm 11 defaults" section to `SKILL.md`

- [ ] Document the on-by-default settings (`minimumReleaseAge: 1440`, `strictDepBuilds`, `blockExoticSubdeps`) and the `pnpm-workspace.yaml` config surface (`publicHoistPattern`, `minimumReleaseAgeExclude`, `allowBuilds`).
- [ ] Note `allowBuilds` replaced the legacy `onlyBuiltDependencies` family, and `esbuild: false` is the correct/default choice.

### Task A3: Add a "Migrating 2.x → 3.0.0 / pnpm 10 → 11" runbook to `references/standardization.md`

- [ ] Step-by-step capturing the verified gotchas: bump ts-builds → `^3.0.0`; `doctor --fix` (relocates hoist patterns); `corepack use pnpm@11` then `CI=true pnpm install`; resolve `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` by adding the flagged `pkg@version` (+ first-party libs) to `minimumReleaseAgeExclude`; resolve `ERR_PNPM_IGNORED_BUILDS` via `allowBuilds`; validate.
- [ ] Cross-reference from `SKILL.md` so an agent loading the skill finds the runbook.

### Task A4: Release so the skill cache refreshes

- [ ] The skill is consumed from the plugin cache; cut a ts-builds release (or document the cache-refresh step) so updated skill content reaches sessions. Verify `npx ts-builds@latest` carries the synced docs.

---

## Phase B — Extend `doctor` to guide the judgment calls (feature, needs TDD + release)

### Task B1: Detect `minimumReleaseAge` violations in `detectPnpm11Issues()`

- [ ] Run a non-mutating policy check (shell `pnpm install --frozen-lockfile`/equivalent, capture `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` entries) and surface each flagged `pkg@version` as a `CheckResult` warning with the suggested `minimumReleaseAgeExclude` line. (Design decision to lock in the plan: shell-out vs. parse lockfile timestamps against a 1440 default.)
- [ ] Tests: fixture with a too-fresh lockfile entry → warning lists the exact `pkg@version`.

### Task B2: Detect ignored builds / `allowBuilds` gaps

- [ ] Detect packages with un-decided build scripts (the `ERR_PNPM_IGNORED_BUILDS` set) and surface an `allowBuilds` scaffold suggestion, defaulting known-safe tools (e.g. `esbuild: false`) with a rationale.
- [ ] Tests: fixture with esbuild present and no `allowBuilds` → warning proposes `allowBuilds.esbuild: false`.

### Task B3: Wire both into `migratePnpm11()` / `doctor --fix`

- [ ] `--fix` appends the flagged `minimumReleaseAgeExclude` entries (pinned `pkg@version` for no-aged-alternative deps; bare names for first-party libs) and the `allowBuilds` map to `pnpm-workspace.yaml`, preserving existing content and the deferred-source-mutation safety pattern already in `migratePnpm11()`.
- [ ] Tests: `--fix` on a fixture produces a `pnpm-workspace.yaml` that passes `pnpm install` clean.

### Task B4: Validate + release

- [ ] `pnpm validate` green; bump + publish; confirm `doctor` / `doctor --fix` guide a real consumer migration end-to-end.

---

## Suggested decisions to lock before implementing Phase B

1. **minimumReleaseAge detection mechanism:** shell out to pnpm and parse the error (accurate, depends on pnpm in PATH) vs. read lockfile publish timestamps against the 1440 default (no shell-out, must track the default). Recommend shell-out — it tracks pnpm's actual policy including future default changes.
2. **First-party exclude list:** hardcode a sensible default (`ts-builds`, `functype`/`functype-*`) vs. infer from `dependencies`. Recommend a documented default that consumers can extend.
3. **Scope of `allowBuilds` defaults:** only suggest `false` for a curated known-safe set (esbuild) and leave everything else for explicit human decision.
