export const bundledPackages = [
  "@eslint/js",
  "@vitest/coverage-v8",
  "@vitest/ui",
  "cross-env",
  "eslint",
  "eslint-config-prettier",
  "eslint-plugin-prettier",
  "eslint-plugin-simple-import-sort",
  "prettier",
  "rimraf",
  "ts-node",
  "typescript",
  "typescript-eslint",
  "vitest",
] as const

export type BundledPackage = (typeof bundledPackages)[number]

export function showHelp(): void {
  console.log(`
ts-builds - Shared TypeScript build tooling

USAGE:
  npx ts-builds [command]

SETUP COMMANDS:
  init      Initialize project with .npmrc hoist patterns (default)
  config    Create ts-builds.config.json (use --force to overwrite)
  info      Show bundled packages you don't need to install
  cleanup   Remove redundant dependencies from package.json
  help      Show this help message

SCRIPT COMMANDS:
  validate      Run full validation chain (configurable)
  format        Format code with Prettier (--write)
  format:check  Check formatting without writing
  lint          Lint and fix with ESLint
  lint:check    Check lint without fixing
  typecheck     Run TypeScript type checking (tsc --noEmit)
  test          Run tests once (vitest run)
  test:watch    Run tests in watch mode
  test:coverage Run tests with coverage
  test:ui       Launch Vitest UI
  build         Production build (tsdown or vite build, based on buildMode)
  build:watch   Watch mode build
  dev           Development mode (tsdown --watch or vite dev server)
  preview       Preview production build (vite preview)

ANALYSIS COMMANDS:
  size          Report bundle sizes (use --save to update baseline)
  doctor        Check package health (exports, files, types)
  changelog     Generate changelog from conventional commits

CONFIGURATION:
  Create ts-builds.config.json in your project root:

  Basic:
  {
    "srcDir": "./src",
    "validateChain": ["format", "lint", "typecheck", "test", "build"]
  }

  For SPAs/React apps using Vite:
  {
    "srcDir": "./src",
    "buildMode": "vite"
  }

  With custom ESLint plugins (e.g., eslint-plugin-react-hooks):
  {
    "srcDir": "./src",
    "lint": {
      "useProjectEslint": true
    }
  }

  Advanced (monorepo with custom commands):
  {
    "srcDir": "./src",
    "commands": {
      "docs:validate": "pnpm docs:build && pnpm docs:check",
      "landing:validate": { "run": "pnpm validate", "cwd": "./landing" }
    },
    "chains": {
      "validate": ["validate:core", "validate:landing"],
      "validate:core": ["format", "lint", "compile", "test", "docs:validate", "build"],
      "validate:landing": ["landing:validate"]
    }
  }

USAGE IN PACKAGE.JSON:
  {
    "scripts": {
      "validate": "ts-builds validate",
      "validate:core": "ts-builds validate:core",
      "format": "ts-builds format",
      "lint": "ts-builds lint",
      "test": "ts-builds test",
      "build": "ts-builds build"
    }
  }

EXAMPLES:
  npx ts-builds validate       # Run default validation chain
  npx ts-builds validate:core  # Run named chain
  npx ts-builds lint           # Run single command
`)
}

export function showInfo(): void {
  console.log(`
ts-builds bundles these packages:

You DON'T need to install:
${bundledPackages.map((pkg) => `  - ${pkg}`).join("\n")}

You ONLY need to install:
  - ts-builds (this package)
  - tsdown (peer dependency, for library builds - optional)
  - vite (peer dependency, for SPA builds - optional)

Example minimal package.json for libraries:
{
  "devDependencies": {
    "ts-builds": "^3.0.0",
    "tsdown": "^0.19.0"
  }
}

Example minimal package.json for SPAs/React apps:
{
  "devDependencies": {
    "ts-builds": "^3.0.0",
    "vite": "^7.0.0"
  }
}
`)
}
