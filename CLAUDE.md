# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript library template designed to be cloned/forked for creating new npm packages. It provides standardized build scripts, modern tooling, and dual module format support (CommonJS + ES modules).

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

### Publishing

- `prepublishOnly` - Automatically runs `pnpm validate` before publishing

### Type Checking

- `pnpm ts-types` - Check TypeScript types with tsc

## Architecture

### Build System

- **tsup**: Primary build tool configured in `tsup.config.ts`
- **Dual Output Directories**:
  - `lib/` - Development builds (NODE_ENV !== "production", used during `pnpm dev`)
  - `dist/` - Production builds (NODE_ENV === "production", used for publishing)
- **Format Support**: Generates both CommonJS (`.js`) and ES modules (`.mjs`)
- **TypeScript**: Auto-generates `.d.ts` declaration files for both formats
- **Environment-Based Behavior**:
  - Production: minified, bundled, no watch
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
- **Exports**: Supports both `require()` and `import` with proper type definitions
- **Publishing**:
  - Configured for npm with public access
  - Both `lib/` and `dist/` directories are published (see package.json "files" field)
  - `prepublishOnly` hook ensures full validation before publish

### TypeScript Configuration

- **Strict Mode**: Enabled with some pragmatic exceptions:
  - `noImplicitAny: false` - Allows implicit any for flexibility
  - `strictPropertyInitialization: false` - Relaxed for constructor properties
- **Target**: ESNext for modern JavaScript features
- **Output**: TypeScript only emits declaration files; tsup handles transpilation

## CLI Usage

This package includes a CLI for initializing projects and managing dependencies.

### Commands

```bash
npx typescript-template-configs          # init (default) - create .npmrc
npx typescript-template-configs help     # show help and usage
npx typescript-template-configs info     # list bundled packages
npx typescript-template-configs cleanup  # remove redundant deps from package.json
npx typescript-template-configs cleanup --yes  # auto-confirm removal
```

### Bundled Packages

The CLI's `info` command shows all 19 packages bundled with this config that users don't need to install:

- eslint, prettier, typescript, vitest
- @typescript-eslint/eslint-plugin, @typescript-eslint/parser
- eslint-config-prettier, eslint-plugin-prettier, eslint-plugin-import, eslint-plugin-simple-import-sort
- @eslint/js, @eslint/eslintrc, globals
- @vitest/coverage-v8, @vitest/ui
- cross-env, rimraf, ts-node, @types/node

Only peer dependency needed: `tsup`

### Local Development

```bash
# Build first, then test
pnpm build
node dist/cli.js help
node dist/cli.js info

# Or link globally
pnpm link --global
typescript-template-configs help
```

### CLI Architecture

- **Source**: `src/cli.ts` - TypeScript CLI source
- **Output**: `dist/cli.js` - Compiled CLI with shebang
- **Templates directory**: `templates/` - Source files to copy
- **Published files**: `dist/` and `templates/` included in npm package
- **Commands**: help, info, cleanup, init (default)

## Key Files

- `src/index.ts` - Main library entry point
- `src/cli.ts` - CLI script for project initialization (TypeScript)
- `templates/npmrc` - Template for .npmrc (hoists CLI binaries)
- `test/*.spec.ts` - Test files using Vitest
- `tsup.config.ts` - Build configuration with environment-based settings (line 3 checks NODE_ENV)
- `vitest.config.ts` - Test configuration with coverage settings
- `eslint.config.mjs` - Linting rules and TypeScript integration
- `STANDARDIZATION_GUIDE.md` - Instructions for applying this pattern to other projects
