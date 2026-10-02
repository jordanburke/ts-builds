# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); sections are generated from
conventional commits via `ts-builds changelog`.

## [Unreleased]

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

**To downgrade a rule while you migrate**, add an override after the preset. This also suits
tooling folders such as `scripts/` that do not depend on `functype`:

```js
import functype from "ts-builds/eslint-functype"

export default [
  ...functype,
  {
    files: ["scripts/**"],
    rules: {
      "functype/no-imperative-loops": "off",
      "functype/prefer-functype-set": "off",
      "functype/prefer-functype-map": "off",
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
