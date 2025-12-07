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
npx ts-builds init      # Creates .npmrc with hoist patterns
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

npx ts-builds init      # Creates .npmrc
npx ts-builds config    # Creates config file
npx ts-builds cleanup   # Remove redundant dependencies

npx ts-builds validate
```

## CLI Commands

### Setup Commands

```bash
npx ts-builds init           # Create .npmrc with hoist patterns
npx ts-builds config         # Create ts-builds.config.json
npx ts-builds config --force # Overwrite existing config
npx ts-builds info           # Show bundled packages
npx ts-builds cleanup        # Remove redundant dependencies
npx ts-builds help           # Show all commands
```

### Script Commands

```bash
npx ts-builds validate       # Run full validation chain
npx ts-builds format         # Format with Prettier
npx ts-builds format:check   # Check formatting only
npx ts-builds lint           # Lint with ESLint (--fix)
npx ts-builds lint:check     # Check lint only
npx ts-builds typecheck      # TypeScript type checking
npx ts-builds test           # Run tests once
npx ts-builds test:watch     # Watch mode
npx ts-builds test:coverage  # With coverage
npx ts-builds build          # Production build
npx ts-builds dev            # Watch mode build
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

## Extendable Configs

ts-builds exports base configurations you can extend:

### ESLint

```javascript
// eslint.config.mjs
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

## Bundled Packages

Run `npx ts-builds info` to see all bundled packages. You don't need to install:

- eslint, prettier, typescript, vitest
- @typescript-eslint/eslint-plugin, @typescript-eslint/parser
- eslint-config-prettier, eslint-plugin-prettier, eslint-plugin-import
- @vitest/coverage-v8, @vitest/ui
- cross-env, rimraf, ts-node
- And more...

## License

MIT
