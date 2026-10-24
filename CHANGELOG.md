# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); sections are generated from
conventional commits via `ts-builds changelog`.

## [Unreleased]

## 4.0.2 (2026-10-24)

### Bug Fixes

- **doctor:** the `minimumReleaseAge` check runs again on pnpm 12 (#206). It ran
  `pnpm install --resolution-only`, which pnpm 12 rejects, and `doctor` ignored the failure and
  reported "pnpm 11 ready" without checking. It now runs `pnpm install --lockfile-only`, which pnpm
  11 and 12 both support. Older gaps fixed with it:
  - On recent pnpm 11 too (verified on 11.27.0), the default lenient mode prints the too-new
    packages in a form the parser did not read, so nothing was flagged. `doctor` now reads both of
    pnpm's output forms. pnpm 12 wraps its errors at 80 columns and splits dates and package names
    at hyphens, so `doctor` rejoins those lines before reading them.
  - pnpm 12 run from a monorepo package adds the entries to the root `pnpm-workspace.yaml` without
    printing them, so `doctor` also reads what pnpm wrote there. pnpm writes scoped entries
    single-quoted (`- '@scope/name@1.0.0'`), and `doctor` now reads those quotes, both here and when
    `--fix` checks which entries already exist.
  - In lenient mode pnpm writes the too-new packages into `pnpm-workspace.yaml` during the probe,
    and `doctor` left that edit behind. The probe now restores `pnpm-workspace.yaml` as well as
    `pnpm-lock.yaml`, including at a monorepo's workspace root.
- **doctor:** when pnpm fails without reporting a too-new package, `doctor` now warns that the
  check could not run, instead of reporting ready. `doctor --fix` reports the step as skipped.
- **doctor:** `doctor --fix` run from a monorepo package no longer writes `minimumReleaseAgeExclude`
  into the package's own `pnpm-workspace.yaml`, which pnpm never reads. It names the workspace root
  to run `--fix` from instead.
- **doctor:** one limit to know about. `--lockfile-only` doesn't re-resolve versions the lockfile
  already pins. pnpm checks those through its lockfile verification instead, and `doctor` reads
  that error. But pnpm caches a passing verification on each machine and reuses it for the same
  lockfile. A lenient install on the same machine records a pass, so `doctor` then reports ready
  for a lockfile that pins too-new versions, while a CI runner with a cold cache fails the install.
  Verified on pnpm 11.27.0 and 12.15.0. The old `--resolution-only` probe re-resolved everything,
  but pnpm 12 has no equivalent flag.

## 4.0.1 (2026-10-23)

### Dependencies

- update bundled dependencies within their existing ranges, no majors (#203): `typescript-eslint` 8.72.0,
  `eslint-plugin-functype` / `eslint-config-functype` 2.119.0, `functype` / `functype-os` 1.19.0, plus
  Dependabot patch and minor bumps since 4.0.0. TypeScript stays on 6.0, because `typescript-eslint`
  does not support TypeScript 7 yet.

### CI/CD

- drop the unpermitted Dependabot Approve step and pin `.nvmrc` to 24.21.0 (#195)
- drop a trailing blank line that prettier rewrote on every validate (#204)

## 4.0.0 (2026-10-03)

### ⚠ Breaking changes

#### Bundled vitest moves to 5

ts-builds ships `vitest`, `@vitest/ui` and `@vitest/coverage-v8` as dependencies, so this
release moves every consumer to vitest 5 (`^5.0.3`).

- **Node 22.12+ is required.** `engines.node` is now `^22.12.0 || ^24.0.0 || >=26.0.0`,
  matching vitest 5. Vite 6.4+ is required, which the `vite` peer range (`^7 || ^8`) already covers.
- **Keep all three vitest packages on the same version.** `@vitest/ui` and `@vitest/coverage-v8`
  peer on vitest at an exact patch. If you pin `vitest` yourself at 4 while on ts-builds 4.0,
  hoisting can leave you with vitest 5 types and a vitest 4 runner. Remove your own pin, or
  move it to 5.
- The shipped `ts-builds/vitest` base config needs no changes. Its `globals`, `environment`,
  `include` and coverage settings behave the same under vitest 5.

Vitest 5 changes that can break existing tests (see the
[vitest 5 migration guide](https://main.vitest.dev/guide/migration)):

- `clearMocks` is on by default. Mock call history resets before every test. Set
  `clearMocks: false` to keep the old behavior.
- `vi.mock`, `vi.unmock` and `vi.hoisted` must be called at the top level of a file.
  `vi.doMock` is unaffected.
- `toThrow("")` now matches any error message. Use `toThrow(/^$/)` to match an empty one.
- `bench` is a test fixture, not a top-level import:
  `test("sort", async ({ bench }) => { await bench("sort", fn).run() })`. Files keep their
  `.bench.ts` names, and `vitest run` skips them.
- The JSON and JUnit reporters write into a `.vitest/` directory instead of stdout. Add
  `.vitest/` to `.gitignore`.
- Config files are no longer looked up from parent directories. A monorepo package that relied
  on a `vitest.config.ts` at the workspace root must pass `--config` or get its own config.

#### `validate:*` commands can no longer leave the package (#72)

A `commands["validate:X"]` entry whose `cwd` escapes the package root now fails with exit
code 1 instead of running. It has printed a deprecation warning since 2.8.0. Commands without
the `validate:` prefix, and `validate:*` commands whose `cwd` stays inside the package, are
unaffected. Use Turbo, nx or `pnpm -r` for cross-package validation.

### Bug Fixes

- **chains**: a chain reached from two branches of another chain (for example
  `validate: ["a", "b"]` where both `a` and `b` include `shared`) now runs. It was reported
  as `Circular chain reference detected` and failed. Real cycles are still caught.

### Dependencies

- raise the floors to `functype ^1.11.0`, `eslint-plugin-functype ^2.111.0` and `eslint-config-functype ^2.111.0`

### Upgrade note: the functype ESLint preset is stricter

This affects you only if you lint with `ts-builds/eslint-functype` (`eslint.config.functype.js`).
That preset spreads `eslint-plugin-functype`'s `recommended` rules, so it carries whatever
plugin version resolves. 2.111.0 already fell inside the old `^2.109.0` range, so a fresh
install or lockfile update may have pulled it in before this release.

Five rules moved from `warn` to `error` in `recommended`:

- `functype/no-imperative-loops`
- `functype/prefer-map`
- `functype/prefer-fold`
- `functype/prefer-functype-map`
- `functype/prefer-functype-set`

`functype/no-let` already errored. `prefer-option`, `prefer-either` and `prefer-try` still warn.

Several defaults changed to cut false positives:

- `prefer-fold` checks predicate calls only. Set `checkNullable: true` to also report plain null checks.
- `prefer-map` no longer reports loops (`checkForLoops: false`), because `no-imperative-loops` covers them.
- `prefer-functype-map` / `prefer-functype-set` skip a native `Map`/`Set` the code mutates on purpose (`allowMutable: true`).
- `no-imperative-loops` skips `for await` loops and loops whose body `yield`s.
- `prefer-option` skips `T | null` inside `useState` / `useRef` type arguments (`allowUseState: true`).

The `@invariant` JSDoc tag from functype 1.10.0 is gone in 1.11.0, along with the
`allowInvariantMarker` rule option. A config that still sets `allowInvariantMarker` now fails
validation. Use `invariant(cond, msg)` from `functype` for bug checks instead, and
`@interop <reason>` or `orThrow(builder)` where a host needs a throw.

**How to fix:** replace push-only loops with `map` / `filter` / `flatMap`, index scans with
`findIndex` / `find`, accumulator loops with `reduce` or `fold`, and lookup `Set` / `Map`
literals with functype's `Set` / `Map`. See the
[eslint-plugin-functype README](https://www.npmjs.com/package/eslint-plugin-functype) for the
boundary tools (`Wire<T>`, `@interop`, `invariant()`).

**To downgrade a rule while you migrate**, add an override after the preset. In a tooling
folder that cannot import `functype` (for example `scripts/` in a package with no `functype`
dependency), downgrade only the two rules whose fix needs functype's `Map` / `Set`. Keep
`no-let`, `no-imperative-loops` and `prefer-map` on there, because their fixes use plain
`const` and native array methods:

```js
import functype from "ts-builds/eslint-functype"

export default [
  ...functype,
  {
    files: ["scripts/**"],
    rules: {
      "functype/prefer-functype-map": "off",
      "functype/prefer-functype-set": "off",
    },
  },
]
```

## 3.4.1 (2026-08-17)

### CI/CD

- bump actions off Node 20 runtimes, add Node 22.x to test matrix (#151) ([fc49b85](https://github.com/jordanburke/ts-builds/commit/fc49b85b4aa04f14b9d4262c79815f8ed4d21f62)) [#151](https://github.com/jordanburke/ts-builds/issues/151), [#150](https://github.com/jordanburke/ts-builds/issues/150)

> Verified against the published package: `npm install ts-builds@3.4.1` resolves with the bundled `eslint@10.8.1`, and `lint:summary` aggregates per-package sidecars correctly in a two-package monorepo — the CI-gating exit code fires on errors, goes green when clean, and fails closed on zero reports.

## 3.4.0 (2026-08-17)

### Features

- **lint**: aggregate lint results across a monorepo with `lint:summary` (#149) ([3c8ad17](https://github.com/jordanburke/ts-builds/commit/3c8ad17333c33704f7834597ee56d41cc7bd54a5)) [#149](https://github.com/jordanburke/ts-builds/issues/149)

  Each `ts-builds lint` / `lint:check` writes a machine-readable per-package sidecar
  `.ts-builds/lint-report.json`; the new `ts-builds lint:summary [dir]` aggregates
  those into one grand total with a CI-gating exit code (nonzero on any package with
  errors, a crash, an unreadable report, or zero reports found). The bundled lint path
  now runs ESLint via its Node API for exact counts; `useProjectEslint: true` keeps the
  spawn and emits no sidecar.
