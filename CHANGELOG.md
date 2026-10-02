# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); sections are generated from
conventional commits via `ts-builds changelog`.

## [Unreleased]

### ⚠ Breaking changes (4.0.0)

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
