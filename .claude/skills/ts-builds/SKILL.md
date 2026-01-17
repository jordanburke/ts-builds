---
name: ts-builds
description: Guide for creating TypeScript libraries using ts-builds and applying its standards to existing projects. Use when setting up new npm packages, standardizing build scripts, configuring tooling (tsdown, Vitest, ESLint, Prettier), or applying ESM patterns.
---

# ts-builds

## Overview

This skill helps you create professional TypeScript libraries using the **ts-builds** package and apply these standards to existing projects. It provides a modern, production-ready setup with ESM-only output, comprehensive testing, and consistent code quality tooling.

**ts-builds** bundles all tooling (ESLint, Prettier, Vitest, TypeScript) and provides a CLI for running standardized commands across projects.

## When to Use This Skill

Trigger this skill when:

- Creating a new TypeScript library or npm package
- Standardizing build scripts across TypeScript projects
- Setting up ESM-only TypeScript projects
- Configuring modern tooling (tsdown, Vitest, ESLint, Prettier)
- Applying consistent code quality standards
- Publishing packages to npm
- Migrating from older build tools (webpack, rollup, tsc alone)

## Quick Start

### Scenario 1: Creating a New Project

```bash
# Create new project
mkdir my-library && cd my-library
pnpm init

# Install ts-builds (bundles all tooling)
pnpm add -D ts-builds tsdown

# Initialize project
npx ts-builds init      # Creates .npmrc with hoist patterns
npx ts-builds config    # Creates ts-builds.config.json

# Create source files
mkdir src test
echo 'export const hello = () => "Hello!"' > src/index.ts

# Set up package.json scripts (see below)

# Validate everything works
npx ts-builds validate
```

### Scenario 2: Applying Standards to Existing Project

```bash
# Install ts-builds
pnpm add -D ts-builds tsdown

# Initialize and configure
npx ts-builds init      # Creates .npmrc with hoist patterns
npx ts-builds config    # Creates ts-builds.config.json
npx ts-builds cleanup   # Remove redundant dependencies

# Update package.json scripts to use ts-builds CLI (see below)

# Validate
npx ts-builds validate
```

## CLI Reference

### Setup Commands

```bash
npx ts-builds            # Default: runs init
npx ts-builds init       # Create .npmrc with hoist patterns (run first)
npx ts-builds config     # Create ts-builds.config.json
npx ts-builds config --force  # Overwrite existing config (or -f)
npx ts-builds info       # Show bundled packages you don't need to install
npx ts-builds cleanup    # Remove redundant dependencies from package.json
npx ts-builds cleanup --yes   # Auto-confirm removal (or -y)
npx ts-builds help       # Show all commands (or --help, -h)
```

### Script Commands

```bash
npx ts-builds validate       # Run full validation chain (configurable)
npx ts-builds format         # Format with Prettier (--write)
npx ts-builds format:check   # Check formatting only
npx ts-builds lint           # Lint with ESLint (--fix)
npx ts-builds lint:check     # Check lint only
npx ts-builds typecheck      # TypeScript type checking (tsc --noEmit)
npx ts-builds ts-types       # Alias for typecheck
npx ts-builds test           # Run tests once (vitest run)
npx ts-builds test:watch     # Watch mode (vitest)
npx ts-builds test:coverage  # With coverage report (vitest run --coverage)
npx ts-builds test:ui        # Interactive UI (vitest --ui)
npx ts-builds build          # Production build (tsdown or vite, based on buildMode)
npx ts-builds build:watch    # Watch mode build
npx ts-builds dev            # Dev mode (tsdown --watch or vite dev server)
npx ts-builds preview        # Preview production build (vite preview)
```

### Named Chains and Custom Commands

Run custom validation chains or commands defined in config:

```bash
npx ts-builds validate       # Run default validate chain
npx ts-builds validate:core  # Run named chain "validate:core"
npx ts-builds my-custom-cmd  # Run custom command from config
```

## Core Standards

### Package.json Scripts

Add these scripts to delegate all commands to ts-builds:

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

This ensures consistency across all projects using ts-builds.

### Configuration (ts-builds.config.json)

Create `ts-builds.config.json` in your project root to customize behavior:

**Basic configuration:**

```json
{
  "srcDir": "./src",
  "validateChain": ["format", "lint", "typecheck", "test", "build"]
}
```

**Advanced configuration (monorepos, custom commands):**

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

**Configuration options:**

- `srcDir` - Source directory for linting (default: `./src`)
- `testDir` - Test directory (default: `./test`)
- `buildMode` - Build tool: `"tsdown"` (default, libraries) or `"vite"` (SPAs)
- `lint.useProjectEslint` - Use project's ESLint instead of bundled (default: `false`)
- `validateChain` - Default validate sequence (backward compat)
- `commands` - Custom commands (string or `{ run, cwd }`)
- `chains` - Named command chains (can reference other chains)

**Using Vite for SPAs/React Apps:**

Set `buildMode: "vite"` to use Vite instead of tsdown:

```json
{
  "srcDir": "./src",
  "buildMode": "vite"
}
```

With Vite mode:

- `ts-builds build` → `vite build`
- `ts-builds dev` → `vite` (dev server with HMR)
- `ts-builds preview` → `vite preview`

Requires `vite` as peer dependency instead of `tsdown`.

**Using custom ESLint plugins:**

If your project uses ESLint plugins not bundled with ts-builds (e.g., `eslint-plugin-functional`, `eslint-plugin-react-hooks`), set `lint.useProjectEslint: true`:

```json
{
  "srcDir": "./src",
  "lint": {
    "useProjectEslint": true
  }
}
```

This tells ts-builds to use your project's ESLint installation instead of the bundled version, allowing custom plugins to be resolved correctly.

**Named chains usage:**

```bash
npx ts-builds validate       # Run default chain
npx ts-builds validate:core  # Run named chain
npx ts-builds validate:landing  # Run another chain
```

### ESM-Only Format

The template outputs ESM-only (no CommonJS):

**package.json exports:**

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  }
}
```

**Build outputs:**

- `lib/` - Development builds (NODE_ENV !== "production")
- `dist/` - Production builds (NODE_ENV === "production")
- Both directories published to npm

### Build Configuration (tsdown)

Key features:

- Environment-based output (lib/ vs dist/)
- ESM-only format
- TypeScript declarations (.d.ts)
- Source maps in development
- Minification in production
- Watch mode for development

### Testing (Vitest)

Configuration highlights:

- Node.js environment
- v8 coverage provider
- Multiple reporters (text, json, html)
- Hot reload in watch mode
- UI mode available

### Code Quality

**ESLint:**

- Flat config (eslint.config.mjs)
- TypeScript support
- Prettier integration
- Import sorting with simple-import-sort
- Strict type checking

**Prettier:**

- No semicolons
- Trailing commas
- Double quotes
- 120 character width
- 2 space tabs

**TypeScript:**

- Strict mode enabled
- Pragmatic exceptions:
  - `noImplicitAny: false`
  - `strictPropertyInitialization: false`
- ESNext target
- Declaration files only (tsdown handles transpilation)

## Common Workflows

### Creating a New Library

1. **Clone and customize** (see references/template-setup.md)
2. **Develop** with `pnpm dev` (watch mode)
3. **Test** with `pnpm test:watch`
4. **Validate** with `pnpm validate` before commits
5. **Publish** with `npm publish` (prepublishOnly auto-validates)

### Standardizing an Existing Project

1. **Audit current setup** - identify gaps
2. **Update package.json** - scripts and dependencies
3. **Copy configurations** - tsdown, vitest, eslint
4. **Migrate build** - switch to tsdown with ESM-only
5. **Update exports** - proper ESM exports
6. **Test thoroughly** - ensure all builds work
7. **Update documentation** - new commands and workflows

### Publishing to npm

The template includes safety checks:

```json
{
  "scripts": {
    "prepublishOnly": "pnpm validate"
  }
}
```

This ensures every publish:

1. Formats code correctly
2. Passes all linting
3. Passes all tests
4. Builds successfully

**Publishing workflow:**

```bash
# Update version
npm version patch  # or minor, major

# Publish (prepublishOnly runs automatically)
npm publish --access public
```

## Architecture Patterns

### Environment-Based Builds

The tsdown configuration (line 3 in tsdown.config.ts) checks `NODE_ENV`:

```typescript
const isDev = process.env.NODE_ENV !== "production"

export default defineConfig({
  outDir: isDev ? "lib" : "dist",
  minify: !isDev,
  sourcemap: isDev,
  // ...
})
```

**Why two output directories?**

- `lib/` - Fast development builds, easier debugging
- `dist/` - Optimized production builds, what npm gets

### File Organization

```
project/
├── src/
│   ├── index.ts           # Main entry point
│   └── **/*.ts            # All source files
├── test/
│   └── *.spec.ts          # Vitest tests
├── lib/                   # Dev builds (gitignored)
├── dist/                  # Prod builds (gitignored)
├── tsdown.config.ts         # Build config
├── vitest.config.ts       # Test config
├── eslint.config.mjs      # Lint config
├── .prettierrc            # Format config (optional)
└── package.json           # Scripts + exports
```

## Troubleshooting

### Build Issues

**"Cannot find module" errors:**

- Check package.json exports match build outputs
- Verify .js files exist in dist/
- Ensure types field points to .d.ts file

**Watch mode not working:**

- Check tsdown.config.ts has watch: true for dev
- Verify NODE_ENV is not set to "production"

### Test Issues

**Tests not found:**

- Check vitest.config.ts includes correct pattern
- Verify test files end in .spec.ts or .test.ts
- Ensure test/ directory exists

**Coverage incomplete:**

- Check coverage.include in vitest.config.ts
- Add exclude patterns for generated files

### Import Issues

**ESM import problems:**

- Verify package.json has `"type": "module"`
- Check package.json exports use correct paths
- Verify .js files are generated in dist/

**Type definitions missing:**

- Ensure tsdown config has `dts: true`
- Check .d.ts files generated in dist/
- Verify types field in package.json

## Migration Checklist

When applying these standards to an existing project:

- [ ] Install ts-builds: `pnpm add -D ts-builds tsdown`
- [ ] Run init: `npx ts-builds init`
- [ ] Update package.json scripts to use ts-builds CLI
- [ ] (Optional) Create ts-builds.config.json for customization
- [ ] Run cleanup: `npx ts-builds cleanup` to remove redundant deps
- [ ] Copy/extend tsdown.config.ts for your project
- [ ] Copy/extend vitest.config.ts for test patterns
- [ ] Copy/extend eslint.config.mjs (or use ts-builds base)
- [ ] Update tsconfig.json for strict mode
- [ ] Update package.json exports for ESM-only format
- [ ] Migrate tests to Vitest (if using different framework)
- [ ] Update GitHub Actions to use `pnpm validate`
- [ ] Update documentation (README, CLAUDE.md)
- [ ] Test with `npx ts-builds validate`
- [ ] Verify published package works in ESM projects

## Resources

### Reference Documents

- **references/template-setup.md** - Complete guide for using the template
- **references/standardization.md** - Detailed migration guide for existing projects
- **references/tooling-reference.md** - Configuration examples and patterns

### External Links

- **ts-builds Package**: https://github.com/jordanburke/ts-builds
- **tsdown Documentation**: https://tsdown.egoist.dev/
- **Vitest Documentation**: https://vitest.dev/
- **ESLint Flat Config**: https://eslint.org/docs/latest/use/configure/configuration-files

### Key Files to Reference

When working with ts-builds, these files contain the canonical configurations:

- `ts-builds.config.json` - Project-specific configuration
- `tsdown.config.ts` - Build configuration with environment logic
- `vitest.config.ts` - Test configuration with coverage
- `eslint.config.mjs` - Linting rules and TypeScript integration
- `package.json` - Scripts, exports, and dependency versions

## Best Practices

### Development Workflow

1. **Always use `pnpm dev`** during development for fast rebuilds
2. **Run `pnpm validate`** before committing changes
3. **Use `pnpm test:watch`** while writing tests
4. **Check `pnpm test:coverage`** to ensure adequate coverage

### Code Quality

1. **Enable strict TypeScript** - catches issues early
2. **Fix linting issues** - don't disable rules without good reason
3. **Write tests** - aim for high coverage on critical paths
4. **Format consistently** - let Prettier handle style

### Publishing

1. **Test locally** - use `npm link` to test before publishing
2. **Version semantically** - follow semver (major.minor.patch)
3. **Update changelog** - document changes for users
4. **Verify ESM works** - test in ESM projects

### Documentation

1. **Keep CLAUDE.md updated** - helps Claude Code assist you
2. **Document commands** - clear examples for all scripts
3. **Explain architecture** - help future maintainers
4. **Link to references** - point to this skill for standards
