# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript library template designed to be cloned/forked for creating new npm packages. It provides standardized build scripts, modern tooling, and ESM-only output.

**Template Usage**: See STANDARDIZATION_GUIDE.md for instructions on applying this pattern to other TypeScript projects.

## Development Commands

### Pre-Checkin Command

- `pnpm validate` - **Main command**: Format, lint, test, and build everything for checkin

### Formatting

- `pnpm format` - Format code with Prettier (write mode)
- `pnpm format:check` - Check Prettier formatting without writing

### Linting

- `pnpm lint` - Fix ESLint issues (write mode)
- `pnpm lint:check` - Check ESLint issues without fixing

### Testing

- `pnpm test` - Run tests once
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test:coverage` - Run tests with coverage report
- `pnpm test:ui` - Launch Vitest UI for interactive testing

### Building

- `pnpm build` - Production build (outputs to `dist/`)
- `pnpm build:watch` - Watch mode build
- `pnpm dev` - Development build with watch mode (alias for build:watch)

### Publishing (Tag-based Release)

Releases are automated via GitHub Actions. To publish a new version:

1. Update version in `package.json`
2. Commit with message like `chore: bump version to X.Y.Z`
3. Create and push a git tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main --tags`
4. GitHub Actions will automatically:
   - Run validation
   - Publish to npm with provenance
   - Create a GitHub Release with auto-generated notes

**Workflows**:

- `publish.yml` - Triggers on `v*` tags, publishes to npm
- `auto-release.yml` - Auto-bumps patch version for dependency updates

### Type Checking

- `pnpm ts-types` - Check TypeScript types with tsc

## Architecture

### Build System

- **tsdown**: Primary build tool configured in `tsdown.config.ts`
- **Dual Output Directories**:
  - `lib/` - Development builds (NODE_ENV !== "production", used during `pnpm dev`)
  - `dist/` - Production builds (NODE_ENV === "production", used for publishing)
- **Format Support**: ESM-only output (`.js` with `"type": "module"`)
- **TypeScript**: Auto-generates `.d.ts` declaration files
- **Environment-Based Behavior**:
  - Production: minified, no watch
  - Development: source maps, watch mode, faster builds

### Testing Framework

- **Vitest**: Modern test runner with hot reload and coverage
- **Configuration**: `vitest.config.ts` with Node.js environment
- **Coverage**: Uses v8 provider with text/json/html reports

### Code Quality Tools

- **ESLint**: Flat config setup in `eslint.config.mjs` with TypeScript support
- **Prettier**: Integrated with ESLint for consistent formatting
- **Import Sorting**: Automatic import organization via `simple-import-sort`

### Package Configuration

- **Entry Points**: Main source in `src/index.ts`, builds all files in `src/**/*.ts`
- **Exports**: ESM imports with proper type definitions
- **Publishing**:
  - Configured for npm with public access
  - Both `lib/` and `dist/` directories are published (see package.json "files" field)
  - `prepublishOnly` hook ensures full validation before publish

### TypeScript Configuration

- **Strict Mode**: Enabled with some pragmatic exceptions:
  - `noImplicitAny: false` - Allows implicit any for flexibility
  - `strictPropertyInitialization: false` - Relaxed for constructor properties
- **Target**: ESNext for modern JavaScript features
- **Output**: TypeScript only emits declaration files; tsdown handles transpilation

## CLI Usage

This package includes a CLI for initializing projects and managing dependencies.

### Commands

```bash
npx ts-builds          # init (default) - create .npmrc
npx ts-builds help     # show help and usage
npx ts-builds info     # list bundled packages
npx ts-builds cleanup  # remove redundant deps from package.json
npx ts-builds cleanup --yes  # auto-confirm removal
```

### Bundled Packages

The CLI's `info` command shows all 18 packages bundled with this config that users don't need to install:

- eslint, prettier, typescript, vitest
- @typescript-eslint/eslint-plugin, @typescript-eslint/parser
- eslint-config-prettier, eslint-plugin-prettier, eslint-plugin-import, eslint-plugin-simple-import-sort
- @eslint/js, @eslint/eslintrc, globals
- @vitest/coverage-v8, @vitest/ui
- cross-env, rimraf, ts-node

### Local Development

```bash
# Build first, then test
pnpm build
node dist/cli.js help
node dist/cli.js info

# Or link globally
pnpm link --global
ts-builds help
```

### CLI Architecture

- **Source**: `src/cli.ts` - TypeScript CLI source
- **Output**: `dist/cli.js` - Compiled CLI with shebang
- **Published files**: `dist/` included in npm package
- **Commands**: help, info, cleanup, init (default)

Only peer dependency needed: `tsdown`

### CLI Configuration

Create `ts-builds.config.json` in your project root to customize behavior:

```json
{
  "srcDir": "./src",
  "testDir": "./test",
  "lint": {
    "useProjectEslint": true
  },
  "validateChain": ["format", "lint", "typecheck", "test", "build"]
}
```

**Configuration Options:**

| Option                  | Type     | Default                                            | Description                                                  |
| ----------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `srcDir`                | string   | `"./src"`                                          | Source directory for linting                                 |
| `testDir`               | string   | `"./test"`                                         | Test directory                                               |
| `lint.useProjectEslint` | boolean  | `false`                                            | Use project's ESLint instead of bundled (for custom plugins) |
| `validateChain`         | string[] | `["format", "lint", "typecheck", "test", "build"]` | Commands to run for validate                                 |
| `commands`              | object   | `{}`                                               | Custom commands                                              |
| `chains`                | object   | `{}`                                               | Named command chains                                         |

**Using Custom ESLint Plugins:**

If your project uses ESLint plugins not bundled with ts-builds (e.g., `eslint-plugin-functional`), set `lint.useProjectEslint: true` to use your project's ESLint installation instead of the bundled version.

## Key Files

- `src/index.ts` - Main library entry point
- `src/cli.ts` - CLI script for project initialization (TypeScript)
- `test/*.spec.ts` - Test files using Vitest
- `tsdown.config.ts` - Build configuration
- `vitest.config.ts` - Test configuration with coverage settings
- `eslint.config.mjs` - Linting rules and TypeScript integration
- `STANDARDIZATION_GUIDE.md` - Instructions for applying this pattern to other projects
