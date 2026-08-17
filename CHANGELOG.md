# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); sections are generated from
conventional commits via `ts-builds changelog`.

## [Unreleased]

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
