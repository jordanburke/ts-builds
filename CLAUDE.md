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

This package includes a CLI for initializing projects with required config files.

### Running the CLI

```bash
# After installing the package
npx typescript-template-configs
```

This copies template files to the current directory:
- `templates/npmrc` → `.npmrc` (configures pnpm to hoist CLI binaries)

### Local Development

```bash
# Test the CLI locally
node bin/init.js

# Or link globally
pnpm link --global
typescript-template-configs
```

### CLI Architecture

- **Entry point**: `bin/init.js` - Node.js script that copies templates
- **Templates directory**: `templates/` - Source files to copy
- **Published files**: Both `bin/` and `templates/` are included in npm package

## Key Files

- `src/index.ts` - Main library entry point
- `bin/init.js` - CLI script for project initialization
- `templates/npmrc` - Template for .npmrc (hoists CLI binaries)
- `test/*.spec.ts` - Test files using Vitest
- `tsup.config.ts` - Build configuration with environment-based settings (line 3 checks NODE_ENV)
- `vitest.config.ts` - Test configuration with coverage settings
- `eslint.config.mjs` - Linting rules and TypeScript integration
- `STANDARDIZATION_GUIDE.md` - Instructions for applying this pattern to other projects
