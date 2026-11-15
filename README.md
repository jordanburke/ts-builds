# ts-builds

[![npm version](https://img.shields.io/npm/v/ts-builds.svg)](https://www.npmjs.com/package/ts-builds)
[![Validate](https://github.com/jordanburke/ts-builds/actions/workflows/node.js.yml/badge.svg)](https://github.com/jordanburke/ts-builds/actions/workflows/node.js.yml)

Shared TypeScript build tooling. Bundles ESLint, Prettier, Vitest, TypeScript and provides a CLI for running standardized commands across projects.

## Quick Start

### New Project

```bash
mkdir my-library && cd my-library
pnpm init

# Install (bundles all tooling)
pnpm add -D ts-builds tsdown

# Initialize
npx ts-builds init      # Creates pnpm-workspace.yaml with hoist patterns
npx ts-builds config    # Creates ts-builds.config.json

# Create source files
mkdir src test
echo 'export const hello = () => "Hello!"' > src/index.ts

# Validate
npx ts-builds validate
```

### Existing Project

```bash
pnpm add -D ts-builds tsdown

npx ts-builds init      # Creates pnpm-workspace.yaml
npx ts-builds config    # Creates config file
npx ts-builds cleanup   # Remove redundant dependencies

npx ts-builds validate
```

## CLI Commands

### Setup Commands

```bash
npx ts-builds init           # Create pnpm-workspace.yaml with hoist patterns
npx ts-builds config         # Create ts-builds.config.json
npx ts-builds config --force # Overwrite existing config
npx ts-builds info           # Show bundled packages
npx ts-builds cleanup        # Remove redundant dependencies
npx ts-builds help           # Show all commands
```

### Script Commands

```bash
npx ts-builds validate       # Run full validation chain
npx ts-builds ci             # Check-only validate for CI (never writes)
npx ts-builds format         # Format with Prettier
npx ts-builds format:check   # Check formatting only
npx ts-builds lint           # Lint with ESLint (--fix)
npx ts-builds lint:check     # Check lint only
npx ts-builds lint:summary   # Aggregate per-package lint totals (monorepo)
npx ts-builds typecheck      # TypeScript type checking
npx ts-builds test           # Run tests once
npx ts-builds test:watch     # Watch mode
npx ts-builds test:coverage  # With coverage
npx ts-builds build          # Production build (tsdown or vite)
npx ts-builds dev            # Dev mode (tsdown --watch or vite dev server)
npx ts-builds preview        # Preview production build (vite preview)
```

### Analysis Commands

```bash
npx ts-builds size               # Report bundle sizes (raw + gzip)
npx ts-builds size --save        # Save baseline for delta tracking
npx ts-builds doctor             # Check package health (exports, files, types)
npx ts-builds changelog          # Generate changelog from conventional commits
npx ts-builds changelog --since v1.0.0 --version 2.0.0  # From specific tag
npx ts-builds changelog --output CHANGELOG.md            # Write to file
```

## Package.json Scripts

Add these to delegate all commands to ts-builds:

```json
{
  "scripts": {
    "validate": "ts-builds validate",
    "format": "ts-builds format",
    "format:check": "ts-builds format:check",
    "lint": "ts-builds lint",
    "lint:check": "ts-builds lint:check",
    "typecheck": "ts-builds typecheck",
    "test": "ts-builds test",
    "test:watch": "ts-builds test:watch",
    "build": "ts-builds build",
    "dev": "ts-builds dev",
    "prepublishOnly": "pnpm validate"
  }
}
```

## Configuration

Create `ts-builds.config.json` to customize behavior:

### Basic

```json
{
  "srcDir": "./src",
  "validateChain": ["format", "lint", "typecheck", "test", "build"]
}
```

### With Custom ESLint Plugins

If your project uses ESLint plugins not bundled with ts-builds (e.g., `eslint-plugin-react-hooks`):

```json
{
  "srcDir": "./src",
  "lint": {
    "useProjectEslint": true
  }
}
```

This tells ts-builds to use your project's ESLint installation instead of the bundled version.

### Linting Tests

`ts-builds lint` covers `srcDir`. Set `lint.includeTests` to cover `testDir` as well:

```json
{
  "testDir": "./test",
  "lint": {
    "includeTests": true
  }
}
```

- It's off by default in 4.x, because turning it on can fail `validate` in a repo whose tests were never linted. 5.0 turns it on.
- A `testDir` that doesn't exist is skipped. One with nothing ESLint can lint, such as only JSON fixtures, stops `lint` with exit code 2, the same as an empty `srcDir`.
- `.ts-builds/lint-report.json` and `lint:summary` count both directories.
- The fp and functype configs turn off the rules that misread a test's shape, for test files only: `@typescript-eslint/require-await` and `@typescript-eslint/no-unnecessary-condition`, plus `functype/prefer-option`, `prefer-either` and `prefer-try` in the functype config. The rule lists come from functype's `test-overrides` and `tests` configs. The base config enables none of these, so it has no override.
- The fp and functype configs use type-aware rules, so every test file has to be in a tsconfig. Add `test/**/*` to `include`, or point `parserOptions.project` at a `tsconfig.eslint.json` that has it. On the bundled path, test files outside any tsconfig count as errors and print as one message naming this fix. With `lint.useProjectEslint`, your ESLint reports each one itself.

### For SPAs/React Apps (Vite)

Use Vite instead of tsdown for SPA builds:

```bash
pnpm add -D ts-builds vite
```

```json
{
  "srcDir": "./src",
  "buildMode": "vite"
}
```

With `buildMode: "vite"`:

- `ts-builds build` → `vite build`
- `ts-builds dev` → `vite` (dev server with HMR)
- `ts-builds preview` → `vite preview`

### Bundle Size Thresholds

```json
{
  "size": {
    "maxTotal": 51200,
    "maxFile": 20480,
    "gzip": true,
    "baselineFile": ".ts-builds-size.json"
  }
}
```

### Changelog

```json
{
  "changelog": {
    "types": { "feat": "Features", "fix": "Bug Fixes" },
    "exclude": ["chore", "ci"]
  }
}
```

### CI: `ts-builds ci`

`validate` makes the tree right: it formats with `--write` and lints with `--fix`. That is what you
want before a commit, and wrong in CI, where a check that runs after a fixer inspects a repaired tree and
passes whatever was committed. `ts-builds ci` runs your `validate` chain with each step that writes
swapped for its check: `format` becomes `format:check` and `lint` becomes `lint:check`. Every other step
runs as written.

```bash
npx ts-builds ci                 # one package
pnpm -r exec ts-builds ci        # every package in a pnpm workspace, in dependency order
```

As a package script, run it with `pnpm run ci` or `npm run ci`. **Not `pnpm ci` or `npm ci`:** those are the
package managers' own clean-install commands, so they reinstall, exit 0, and check nothing.

There is no second list to keep in step: add `test` to `validate` and `ci` runs it too. A nested chain is
derived the same way. If you replace `format` or `lint`, replace `format:check` or `lint:check` too:
otherwise `ci` would check with ts-builds' own tool instead of yours, so it fails and says so. Other
commands of your own run as written, so if `validate` runs one that writes files, give `ci` its own chain.
A `chains.ci` or `commands.ci` of your own replaces the derived one:

```json
{
  "chains": {
    "validate": ["format", "lint", "codegen", "test"],
    "ci": ["format:check", "lint:check", "codegen:check", "test"]
  }
}
```

### Advanced (Monorepos, Custom Commands)

```json
{
  "srcDir": "./src",
  "commands": {
    "compile": "tsc",
    "docs:validate": "pnpm docs:build && pnpm docs:check",
    "landing:validate": { "run": "pnpm validate", "cwd": "./landing" }
  },
  "chains": {
    "validate": ["validate:core", "validate:landing"],
    "validate:core": ["format", "lint", "compile", "test", "docs:validate", "build"],
    "validate:landing": ["landing:validate"]
  }
}
```

Run named chains:

```bash
npx ts-builds validate:core
npx ts-builds validate:landing
```

A `commands` entry named after a built-in step (`format`, `format:check`, `lint`, `lint:check`, `typecheck`,
`ts-types`, `test`, `test:watch`, `test:coverage`, `test:ui`, `build`, `build:watch`, `dev`, `preview`) replaces
that step everywhere: inside a chain, and when you run it directly (`ts-builds lint:check`, or
`ts-builds lint check`). A chain with one of those names takes precedence over both, as it does inside a chain.
`compile` can be overridden too, but only runs inside a chain. An override runs your command instead of
ts-builds' lint, so it sends no lint telemetry, and an override of `lint` or `lint:check` removes any old
`.ts-builds/lint-report.json`, so `lint:summary` can't read stale counts.

```json
{
  "commands": {
    "lint": "eslint ./src ./test --fix --max-warnings=0",
    "lint:check": "eslint ./src ./test --max-warnings=0"
  }
}
```

### Aggregating lint results across a monorepo

Under a task runner, `ts-builds` runs per-package, so each package's ESLint output
scrolls past and the repo-wide total is lost. Every `ts-builds lint` / `lint:check`
run writes a machine-readable sidecar at `.ts-builds/lint-report.json`;
`ts-builds lint:summary` reads those sidecars and prints one grand total with a
CI-gating exit code (nonzero if any package has errors or crashed). It **re-runs
nothing** — pure file reads of the last lint.

```bash
turbo run lint --continue   # lint every package (see --continue note below)
ts-builds lint:summary      # print the aggregate total at the repo root
```

Wire-up:

- **Declare the sidecar as a Turbo output** so cache hits still restore it and totals
  stay correct without re-linting:
  ```jsonc
  // turbo.json
  { "tasks": { "lint": { "outputs": [".ts-builds/**"] } } }
  ```
- **Use `--continue`** for a full sweep. Turbo's default (`--continue=never`) cancels
  all remaining tasks on the first failure, so without it a single failing package
  hides every downstream package's issues. The exit code is still the max across tasks.
- **Gitignore `.ts-builds/`** in consuming repos.
- Packages configured with `lint.useProjectEslint: true` run through the consumer's
  own ESLint and do **not** emit a sidecar, so they don't appear in the summary.

`ts-builds lint:summary [dir]` defaults to the current directory; pass a path to
aggregate a different root. Finding zero sidecars exits nonzero — an empty sweep
must not silently pass CI.

The sidecar also has a `rules` field with per-rule counts: errors, warnings, findings
silenced by an `eslint-disable` comment.

### Lint telemetry (opt-in)

`ts-builds lint` can send each run's per-rule counts to an endpoint you run. That shows which
rules fire, which ones people silence, and how both change between releases. It's off unless you
turn it on. ts-builds reads these settings from the environment only, so `ts-builds.config.json`
has no switch for it. A committed script, workflow or config command that sets them still turns it
on for everyone who runs it, so set them only where you mean to, such as your own CI.

| Env var                       | Effect                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TS_BUILDS_TELEMETRY=1`       | Turns it on.                                                                                                               |
| `TS_BUILDS_TELEMETRY_URL`     | Where to POST. Must be `https`, or `http` to localhost. With telemetry on and no URL, `lint` warns once and sends nothing. |
| `TS_BUILDS_TELEMETRY_DEBUG=1` | Prints the payload to stderr and sends nothing, whether or not telemetry is on.                                            |
| `TS_BUILDS_TELEMETRY_TRACE=1` | Adds `trace`: the repo, the commit, and each finding's file and line. See below.                                           |
| `DO_NOT_TRACK=1`              | Turns it off, whatever else is set.                                                                                        |

Each run sends one JSON object:

```json
{
  "schema": 1,
  "package": "@acme/api",
  "project": "3f9c2a1b7d4e6f80",
  "ci": true,
  "agent": "claude-code",
  "fix": false,
  "durationMs": 1840,
  "files": 212,
  "fatal": 0,
  "versions": {
    "node": "24.20.0",
    "ts-builds": "4.2.0",
    "eslint": "10.14.0",
    "typescript": "6.0.3",
    "eslint-plugin-functype": "2.125.1"
  },
  "enabled": { "functype/no-let": "error", "functype/prefer-option": "warn" },
  "rules": { "functype/prefer-option": { "errors": 0, "warnings": 3, "silenced": 2 } },
  "messages": {
    "functype/prefer-option": {
      "preferOption": { "errors": 0, "warnings": 3, "silenced": 0 },
      "preferWireForThreeStates": { "errors": 0, "warnings": 0, "silenced": 2 }
    }
  }
}
```

- **Never sent:** source code or message text. File paths only in `trace`, below.
- **Sent as-is:** the `package.json` name, left out when there isn't one, and rule ids as your config
  names them. A plugin's declared name is used only when it looks like an npm package name, and
  otherwise is replaced by the name derived from its rule prefix, such as `eslint-plugin-<prefix>`. Its
  declared version is used only when it's semver.
- **`project`:** a salted hash of the git remote, so one repo's packages group together. It's a
  stable pseudonym, not anonymity: anyone who knows the remote URL can compute it. It's left out
  when there's no remote.
- **`agent`:** set when a coding agent runs the lint. Today that's Claude Code, from `CLAUDECODE=1`.
- **`versions`:** Node, ts-builds, ESLint, TypeScript, and each configured plugin. A plugin's
  installed version wins over the `meta.version` it declares, which is hand-written and can go stale.
  When the installed package can't be found, the `meta.version` is used.
- **`enabled`:** the plugin rules that are on, with their severity, read from the first linted file's
  config. It tells a rule with no findings apart from a rule that's off. Core rules are left out.
- **`messages`:** each rule's counts split by the message id it reported. A message id is a fixed
  name in the rule's code, such as `preferOption`, not the message text. It shows which of a rule's
  messages fires or gets silenced. Left out when no finding had one.

#### Tracing findings to a line

With `TS_BUILDS_TELEMETRY_TRACE=1` as well, the payload adds `trace`, so each finding can be opened at
the commit that was linted:

```json
"trace": {
  "repo": "github.com/acme/api",
  "commit": "d53e02a1c9b4e8f7a6b5c4d3e2f1a0b9c8d7e6f5",
  "findings": [
    { "rule": "functype/prefer-option", "message": "preferOption", "kind": "silenced", "file": "src/user.ts", "line": 42 }
  ],
  "dropped": 0
}
```

- **What it names:** the repo, from the git remote as `host/owner/repo`, the commit (`HEAD`), and
  each finding's file relative to the repo root and line. It doesn't send code. The code is read at
  the host, under the repo's own access rules.
- **Turn it on only for repos whose names and file paths you're happy to send.** That's why it's a
  separate flag.
- **Lines match the commit.** A finding in an untracked file, or in one that differs from `HEAD`
  because it was edited or rewritten by `--fix`, is left out and counted in `dropped`. If git can't
  say which files are tracked or changed, every finding is left out.
- **Size is capped.** Findings are sorted by file and line. The first 200 are kept, and fewer if
  the payload would pass 60 KB, so a large run still sends its counts. The rest count in `dropped`.
- **No trace** when the directory isn't in a git repo, has no `HEAD`, or its remote isn't
  `host/owner/repo` with a domain name as the host. A local or relative path isn't traced.
- **Message ids** that aren't plain identifiers (letters, digits, `_ . : -`, at most 64) are left
  out of `messages` and the trace.

It never changes a run's result. It sends after lint finishes and its output is printed, the send
waits at most 2 seconds (the trace's git calls can add a few more), and it ignores every error, so the exit code and output stay the same. A run that
fails before linting, such as one with a broken config, sends nothing.

It doesn't cover `lint.useProjectEslint`, which spawns your own ESLint so ts-builds never sees the
results. It also doesn't cover scripts that call `eslint` directly instead of `ts-builds lint`.

To turn it on in GitHub Actions, set both variables on the job:

```yaml
env:
  TS_BUILDS_TELEMETRY: "1"
  TS_BUILDS_TELEMETRY_URL: ${{ vars.TS_BUILDS_TELEMETRY_URL }}
```

Under Turbo's strict env mode, a task only sees the variables Turbo is told about, plus a built-in
set that includes `CI`. List these so `ts-builds lint` sees them. Adding `globalPassThroughEnv` also
turns on strict mode for every task, so check that your other tasks still get the variables they need:

```jsonc
// turbo.json
{
  "globalPassThroughEnv": [
    "TS_BUILDS_TELEMETRY",
    "TS_BUILDS_TELEMETRY_URL",
    "TS_BUILDS_TELEMETRY_DEBUG",
    "DO_NOT_TRACK",
    "GITHUB_ACTIONS",
    "CLAUDECODE",
  ],
}
```

Pass-through variables don't change Turbo's cache key. A cached lint task doesn't run, so it sends
nothing.

## Extendable Configs

ts-builds exports base configurations you can extend:

### ESLint

```javascript
// eslint.config.js
import baseConfig from "ts-builds/eslint"

export default [...baseConfig]
```

### Vitest

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config"
import baseConfig from "ts-builds/vitest"

export default defineConfig(baseConfig)
```

### TypeScript

```json
{
  "extends": "ts-builds/tsconfig",
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

### tsdown

```typescript
// tsdown.config.ts
import baseConfig from "ts-builds/tsdown"

export default baseConfig
```

### Prettier

```json
{
  "prettier": "ts-builds/prettier"
}
```

Opting in explicitly is still worth doing — it makes the style visible to your editor and to a
bare `prettier` run. But it is no longer required for `ts-builds format`: if the CLI finds no
prettier config in your project or any parent directory, it passes its own bundled config. A
config you do have always wins, including one inherited from a monorepo root.

### Vite (for SPAs)

```typescript
// vite.config.ts
import { vite } from "ts-builds/vite"
import { defineConfig, mergeConfig } from "vite"

export default defineConfig(
  mergeConfig(vite, {
    // your customizations
  }),
)
```

### Architecture boundaries (pnpm monorepos, preview)

One policy module, kept in your repo, says which workspaces may import which. `createBoundaries`
turns it into an [eslint-plugin-boundaries](https://www.jsboundaries.dev) config that checks every
import, per file, in the editor and in CI.

```javascript
// architecture.mjs, at the workspace root
import { defineArchitecture } from "ts-builds/architecture"

export default defineArchitecture({
  rootDir: import.meta.dirname,
  workspaces: {
    "@acme/types": { dir: "packages/types", type: "pure" },
    "@acme/rules": { dir: "packages/rules", type: "pure", allow: ["@acme/types"], deny: ["pg", "@ai-sdk/*"] },
    "@acme/db": { dir: "packages/db", type: "infra" },
    "@acme/api": { dir: "apps/api", type: "app", allow: ["@acme/*"] },
  },
  testPolicy: { allowExternals: ["vitest"] },
})
```

```javascript
// eslint.config.js
import { createBoundaries } from "ts-builds/eslint-boundaries"
import baseConfig from "ts-builds/eslint"

import architecture from "./architecture.mjs"

export default [...baseConfig, ...createBoundaries(architecture).configs]
```

`createBoundaries` sets no parser. `ts-builds/eslint` brings one, so the example above parses
TypeScript. A boundary config that doesn't spread `ts-builds/eslint` must set a TypeScript parser
itself, for example `{ files: ["**/*.{ts,mts,cts,tsx}"], languageOptions: { parser: tseslint.parser } }`
with `typescript-eslint` declared in your root `package.json`.

What a policy allows:

- **Other workspaces:** only those its `allow` names, by package name or `@scope/*` glob.
- **External packages:** only those its own `package.json` declares, never one it merely reaches
  through hoisting. A type-only import may also come from a `devDependency`, or from a package
  whose `@types/*` package is declared.
- **Tests:** files under the workspace's `test/`, and `*.test.*`/`*.spec.*` files under its
  `src/`, may also import its `devDependencies` and `testPolicy.allowExternals`, and each other.
  Source files may not import test files, in their own workspace or another.
- **Node core modules:** allowed, unless `deny` names them. `deny: ["fs"]` also stops `node:fs`,
  and a glob such as `node:child_*` covers both spellings too.
- **`deny`:** external packages only, and it wins over a declared dependency for every import
  form: `import`, `import type`, dynamic `import()`, `require`, `import x = require()` and
  re-exports.
- **`"pure"`:** a pure workspace may allow only other pure workspaces.
- **A workspace's own folders beside `src` and `test`:** none, unless its `ownDirs` lists them.
  `ownDirs: ["drizzle"]` lets the workspace's own code import `apps/api/drizzle/...`; another
  workspace importing them still fails, even one whose `allow` names this workspace.
- **Repo files outside every workspace:** none, unless `testPolicy.allowRootFiles` lists them, and
  then only from test files. `allowRootFiles: ["eslint.config.mjs"]` lets a test import the root
  ESLint config. Entries are repo-relative paths, or globs with `*`, `**` and `?`; a glob skips
  dotfiles and `node_modules`, so list such a file exactly.

```javascript
"@acme/api": { dir: "apps/api", type: "app", allow: ["@acme/*"], ownDirs: ["drizzle"] },
// …
testPolicy: { allowExternals: ["vitest"], allowRootFiles: ["eslint.config.mjs"] },
```

A disallowed import of a local file outside every workspace names the file and the option that
would allow it: `ownDirs` for a source file, and `ownDirs` or `testPolicy.allowRootFiles` for a
test file.

`defineArchitecture` throws when the policy doesn't match the disk:

- `rootDir` isn't absolute, or its `pnpm-workspace.yaml` is missing or lists no `packages`.
- A workspace the root lists has no policy, or its `package.json` can't be read.
- A policy names a directory the root doesn't list, or a package name that differs.
- A workspace has no `src`.
- An `allow` entry matches nothing, or a pure workspace allows an impure one.
- A `deny` entry matches a workspace. Leave the workspace out of `allow` instead.
- An `ownDirs` entry isn't an existing plain folder inside the workspace: `.`, a path out of the
  workspace, `node_modules`, anything under `src` or `test` (in any case), a symlink, a name that
  differs in case from the folder on disk, a folder that holds another workspace or a
  `package.json`, or a name with any of `* ? [ ] { } ( ) ! \`.
- A `testPolicy.allowRootFiles` entry matches no file, matches a file inside a workspace (a
  workspace's own folders go in its `ownDirs`), names a symlink or a file in another case, or
  uses a glob other than `*`, `**` and `?`.
- A workspace folder sits inside another workspace's `src` or `test`, where both halves would read
  it as that workspace's own code.
- A dependency installs a workspace under another name: `"alias": "workspace:@scope/b@*"`,
  `npm:@scope/b@…`, or a `workspace:`, `file:` or `link:` path to its folder. Both halves tell a
  workspace import from an external one by name, so the alias would pass as a declared external
  package. Depend on the workspace by its own name.
- A workspace folder, an `ownDirs` folder or a matched file has any of `* ? [ ] { } ( ) ! \` in
  its name. The plugin matches paths with picomatch, which reads `a(b).mjs` as a pattern that
  also matches `ab.mjs`, so such a name can't be allowed exactly.

Each of eslint-plugin-boundaries' defaults that passes silently is forced:

- The root path is your absolute `rootDir`, not the cwd.
- Elements are each workspace's `src` and `test`.
- Imports resolve through `eslint-import-resolver-typescript`, with every workspace's tsconfig, so
  `paths` aliases work. ts-builds loads the resolver itself; you don't install it.
- Anything no policy allows is reported, external modules included.
- A file in a `src` or `test` directory that belongs to no workspace is an error, and so is an
  import of a local file outside every workspace.
- A comment that would silence a `boundaries/*` rule is an error: an `eslint-disable` naming one,
  a blanket `eslint-disable`, or an `/* eslint … */` config comment naming one.

Known limits:

- **Workspaces must export their source.** The fixture's packages export raw `./src/*.ts`, as the
  issue this came from assumes. A workspace whose `exports` point at `dist` resolves to `dist`, which
  belongs to no element, so its imports are reported as having no policy.
- **Code outside `src` and `test` isn't linted,** and a relative path into an allowed workspace
  (`../../packages/x/src/internal.ts`) passes like a package import does. That includes `ownDirs`
  folders: ESLint checks imports into them, not imports out of them. `ts-builds depcruise` checks
  what the `ownDirs` code that `src` or `test` reaches imports (see below).
- **A `testPolicy.allowRootFiles` file's own imports aren't checked,** apart from a `deny` reach.
  A test may import `eslint.config.mjs`, and what that config imports isn't held to any
  workspace's `allow`. List only files that are tooling, not a back door to another workspace.
- **Some disable comments can't be reported,** because ESLint applies them before any rule runs:
  a blanket `/* eslint-disable */` at the very start of a file, an `/* eslint … */` config comment
  that turns `ts-builds/no-boundaries-disable` itself off, an `eslint-disable-line` naming it in a
  one-line file, and combinations of directives placed to cover each other. To rule them all out,
  run the boundary check in CI with `--no-inline-config`.
- **Run the boundary lint from the repo root.** With several tsconfigs, an `@/*` path alias has been
  seen to fail to resolve when linting from inside an app. The fixture's single alias resolves
  from both places.
- **Use `import type { X }`, not `import { type X }`, for a type from a devDependency in `src`.**
  The first always passes. The inline form is reported, because under `verbatimModuleSyntax`
  TypeScript keeps it as a runtime import (`import {} from "pkg"`); without that option both forms
  compile away, but the inline one is still reported.

#### Transitive purity and cycles (CI)

The ESLint rules check one file at a time, so they can't see `@acme/rules` reaching `pg` through a
workspace it is allowed to import. `ts-builds depcruise` checks the whole graph with
[dependency-cruiser](https://github.com/sverweij/dependency-cruiser), from the same policy:

```bash
ts-builds depcruise                    # nearest architecture.mjs, .js or .ts, here or above
ts-builds depcruise ./architecture.mjs # or name the file
```

It exits 0 when clean, 1 on a violation and 2 when it couldn't check, such as a policy that
throws while loading. It reports:

- **`deny-reachable:<workspace>`:** the workspace's `src` or `test` reaches a package its `deny`
  lists, through other workspace modules. Type-only imports count, as they do for ESLint.
- **`no-circular`:** a runtime import cycle between workspace modules. A cycle through type-only
  imports is erased at runtime and isn't reported.
- **`not-to-unresolvable:<workspace>`:** an import that doesn't resolve, unless it names a package
  the workspace declares (directly or through `@types/*`). An unresolved import would end a
  reachability chain silently, and ESLint's resolver can resolve an alias that dependency-cruiser
  can't, so neither half would report a reach through it. It covers the workspace's `ownDirs`
  code too.
- **`own-dirs-boundary:<workspace>`**, **`own-dirs-test-file:<workspace>`**,
  **`own-dirs-workspace-package:<workspace>`** and **`own-dirs-undeclared:<workspace>`:** ESLint
  doesn't lint `ownDirs` folders, so these check what their code imports. A local import must land
  in the workspace's own `src` or `ownDirs`, or in the `src` of a workspace its `allow` names, and
  not on a test file there; anything else, a second hop through a folder beside them, a repo file
  or a relative path into `node_modules` included, is reported where it leaves. A package import
  must name a package the workspace declares, and not an installed copy of another workspace,
  `devDependencies` included: `ownDirs` code is often
  build or migration code, so it may use them at runtime, where `src` may only import their
  types. A `deny` reach through `ownDirs` code is reported by `deny-reachable`. Only code that
  `src` or `test` reaches is cruised, so an `ownDirs` folder nothing imports is skipped, not
  failed.

A test's import of a `testPolicy.allowRootFiles` file resolves like any other, and a `deny` reach
through it is reported.

It fails rather than passes when a rule matches no cruised file, or when dependency-cruiser can't
load TypeScript. It never reads the working directory: run it from the root or from any workspace.
Under pnpm a consumer can't run dependency-cruiser's own CLI, so ts-builds runs it in-process;
`createDepcruise` and `runDepcruise` from `ts-builds/depcruise` expose the generated config and
the run.

Known limits:

- **Injected workspace dependencies aren't supported.** pnpm's `injected` (or
  `injectWorkspacePackages`) installs a copy of a workspace into the consumer's `node_modules`.
  An import of that copy is refused, whether `allow` names the workspace or not: ESLint reports it
  from `src` and `test` as an undeclared external package, and `own-dirs-workspace-package`
  reports it from `ownDirs` code.
- **External packages aren't followed.** A denied package reached only through another external
  package (an allowed `orm` that imports `pg`) isn't reported. Deny the outer package too.
- **Aliases resolve from each workspace's own `tsconfig.json`.** `paths` inherited from a base in
  another directory without `baseUrl`, or kept in a referenced `tsconfig.app.json` behind a
  solution-style `tsconfig.json`, don't resolve, so those imports fail as unresolved. Add a
  `baseUrl`, or move the `paths` into the workspace's `tsconfig.json`.
- **Workspaces must export their source,** as for the ESLint half. A `types` condition is ignored,
  so `{ "types": …, "import": "./src/index.ts" }` follows the code. An export that points at an
  unbuilt `dist` fails as unresolved.

## Bundled Packages

Run `npx ts-builds info` to see all bundled packages. You don't need to install:

- eslint, prettier, typescript, typescript-eslint, vitest
- @eslint/js, eslint-plugin-prettier, eslint-plugin-simple-import-sort
- eslint-config-prettier (flagged by cleanup)
- @vitest/coverage-v8, @vitest/ui
- cross-env, rimraf, ts-node

## License

MIT
