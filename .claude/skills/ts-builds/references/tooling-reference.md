# Tooling Reference

Comprehensive reference for all tooling configurations used in ts-builds.

## ts-builds CLI

ts-builds provides a CLI that runs standardized commands across all projects.

### Setup Commands

```bash
npx ts-builds            # Default: runs init
npx ts-builds init       # Initialize .npmrc with hoist patterns (run first)
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
npx ts-builds test:coverage  # With coverage (vitest run --coverage)
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

### Configuration (ts-builds.config.json)

```json
{
  "srcDir": "./src",
  "lint": {
    "useProjectEslint": false
  },
  "validateChain": ["format", "lint", "typecheck", "test", "build"],
  "commands": {
    "custom-cmd": "echo 'custom'",
    "subdir-cmd": { "run": "pnpm validate", "cwd": "./subproject" }
  },
  "chains": {
    "validate:fast": ["format", "lint", "typecheck"]
  }
}
```

**Configuration options:**

| Option                  | Type     | Default                                            | Description                                                  |
| ----------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `srcDir`                | string   | `"./src"`                                          | Source directory for linting                                 |
| `testDir`               | string   | `"./test"`                                         | Test directory                                               |
| `buildMode`             | string   | `"tsdown"`                                         | Build tool: `"tsdown"` (libraries) or `"vite"` (SPAs)        |
| `lint.useProjectEslint` | boolean  | `false`                                            | Use project's ESLint instead of bundled (for custom plugins) |
| `validateChain`         | string[] | `["format", "lint", "typecheck", "test", "build"]` | Commands to run for validate                                 |
| `commands`              | object   | `{}`                                               | Custom commands                                              |
| `chains`                | object   | `{}`                                               | Named command chains                                         |

**Using custom ESLint plugins:**

If your project uses ESLint plugins not bundled with ts-builds (e.g., `eslint-plugin-functional`), set `lint.useProjectEslint: true` to use your project's ESLint installation:

## tsdown Configuration

tsdown is the build tool that handles TypeScript compilation, bundling, and ESM output generation.

### Basic Configuration

File: `tsdown.config.ts`

```typescript
import type { Options } from "tsdown"

const env = process.env.NODE_ENV

export const tsdown: Options = {
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  format: ["esm"],
  minify: env === "production",
  bundle: env === "production",
  skipNodeModulesBundle: true,
  watch: env === "development",
  target: "es2020",
  outDir: env === "production" ? "dist" : "lib",
  entry: ["src/index.ts", "src/**/*.ts"],
}
```

### Configuration Options Explained

**entry** - Entry points for build:

```typescript
// Single entry
entry: ["src/index.ts"]

// Multiple entries
entry: ["src/index.ts", "src/utils.ts"]

// Glob pattern (all TypeScript files)
entry: ["src/**/*.ts"]
```

**format** - Output module formats:

```typescript
// ESM-only (recommended for modern libraries)
format: ["esm"]

// Legacy dual format (if CJS needed)
format: ["cjs", "esm"]

// Browser format (IIFE)
format: ["iife"]
```

**dts** - TypeScript declaration files:

```typescript
// Generate .d.ts files
dts: true

// Generate with custom options
dts: {
  resolve: true,
  entry: ["src/index.ts"],
}
```

**outDir** - Output directory:

```typescript
// Environment-based (development vs production)
outDir: env === "production" ? "dist" : "lib"

// Fixed directory
outDir: "dist"
```

**minify** - Code minification:

```typescript
// Production only (recommended)
minify: env === "production"

// Always minify
minify: true

// Custom minifier
minify: "terser"
```

**sourcemap** - Source map generation:

```typescript
// Development only (recommended)
sourcemap: env !== "production"

// Always generate
sourcemap: true

// Inline sourcemaps
sourcemap: "inline"
```

**bundle** - Bundle dependencies:

```typescript
// Production only (recommended)
bundle: env === "production"

// Never bundle (useful for libraries)
bundle: false
```

**external** - External dependencies (don't bundle):

```typescript
// Exclude peer dependencies
external: ["react", "react-dom"]

// Regex pattern
external: [/^@myorg\//]
```

**splitting** - Code splitting:

```typescript
// Enable code splitting (for better tree-shaking)
splitting: true

// Disable
splitting: false
```

**target** - JavaScript target:

```typescript
// Modern Node.js
target: "es2020"

// Latest features
target: "esnext"

// Older compatibility
target: "es2015"
```

**watch** - Watch mode:

```typescript
// Development mode only
watch: env === "development"

// Always watch
watch: true

// With options
watch: {
  onRebuild(err) {
    if (err) console.error('Build failed:', err)
    else console.log('Build succeeded')
  }
}
```

**clean** - Clean output directory:

```typescript
// Always clean before build (recommended)
clean: true

// Keep previous builds
clean: false
```

### Advanced Patterns

**Multiple Entry Points with Custom Names:**

```typescript
export const tsdown: Options = {
  entry: {
    index: "src/index.ts",
    utils: "src/utils/index.ts",
    types: "src/types/index.ts",
  },
  format: ["esm"],
  dts: true,
}
```

This generates:

- `dist/index.js`, `dist/index.d.ts`
- `dist/utils.js`, `dist/utils.d.ts`
- `dist/types.js`, `dist/types.d.ts`

**Browser-Compatible Build:**

```typescript
export const tsdown: Options = {
  entry: ["src/index.ts"],
  format: ["esm", "iife"],
  globalName: "MyLib",
  platform: "browser",
  target: "es2015",
  dts: true,
}
```

**Library with Peer Dependencies:**

```typescript
export const tsdown: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  external: ["react", "react-dom"], // Don't bundle peer deps
  skipNodeModulesBundle: true,
}
```

## Vitest Configuration

Vitest is the test runner - fast, modern alternative to Jest.

### Basic Configuration

File: `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.d.ts", "**/*.test.{js,ts}", "**/*.config.{js,ts}"],
    },
  },
})
```

### Configuration Options Explained

**globals** - Global test functions:

```typescript
// Enable globals (describe, it, expect available without import)
globals: true

// Require explicit imports
globals: false
```

**environment** - Test environment:

```typescript
// Node.js environment (for libraries)
environment: "node"

// Browser-like environment (for browser code)
environment: "jsdom"

// Happy DOM (faster alternative to jsdom)
environment: "happy-dom"
```

**include** - Test file patterns:

```typescript
// All common test patterns (default)
include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"]

// Only .spec.ts files
include: ["**/*.spec.ts"]

// Custom directory
include: ["test/**/*.test.ts"]
```

**exclude** - Exclude patterns:

```typescript
exclude: ["node_modules/", "dist/", ".idea/", ".git/", "**/*.d.ts"]
```

**coverage.provider** - Coverage tool:

```typescript
// v8 (faster, Node.js built-in)
provider: "v8"

// istanbul (more accurate in some cases)
provider: "istanbul"
```

**coverage.reporter** - Coverage report formats:

```typescript
// Multiple formats
reporter: ["text", "json", "html"]

// Text only (for CI)
reporter: ["text"]

// With lcov for tools like Codecov
reporter: ["text", "lcov"]
```

**coverage.include** - Files to cover:

```typescript
include: ["src/**/*.ts"]
```

**coverage.exclude** - Files to exclude from coverage:

```typescript
exclude: ["node_modules/", "dist/", "**/*.d.ts", "**/*.test.ts", "**/*.spec.ts", "**/*.config.ts"]
```

**coverage.threshold** - Minimum coverage:

```typescript
coverage: {
  threshold: {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  }
}
```

### Advanced Patterns

**Test Setup File:**

```typescript
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"], // Runs before each test file
  },
})
```

Example `test/setup.ts`:

```typescript
import { expect } from "vitest"

// Custom matchers or global setup
beforeEach(() => {
  // Runs before each test
})
```

**Multiple Environments:**

```typescript
export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ["**/*.dom.test.ts", "jsdom"], // DOM tests use jsdom
      ["**/*.node.test.ts", "node"], // Node tests use node
    ],
  },
})
```

**Watch Mode Options:**

```typescript
export default defineConfig({
  test: {
    watch: false, // Disable watch in CI
    poolOptions: {
      threads: {
        singleThread: true, // For debugging
      },
    },
  },
})
```

## ESLint Configuration

ESLint 10 with native flat config. No FlatCompat needed.

### Basic Configuration (Flat Config)

File: `eslint.config.js` (works with `"type": "module"` in package.json)

```javascript
import js from "@eslint/js"
import prettierRecommended from "eslint-plugin-prettier/recommended"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import globals from "globals"
import tseslint from "typescript-eslint"

export default [
  {
    ignores: [
      "**/.gitignore",
      "**/.eslintignore",
      "**/node_modules",
      "**/.DS_Store",
      "**/dist",
      "**/lib",
      "**/coverage",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
      ecmaVersion: 2020,
      sourceType: "module",
    },
    rules: {
      "prettier/prettier": ["error", {}, { usePrettierrc: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
]
```

### Key Configuration Sections

**ignores** - Files to ignore:

```javascript
{
  ignores: ["**/node_modules", "**/dist", "**/lib", "**/coverage", "**/*.d.ts"]
}
```

**Base configs** - Spread recommended configs:

```javascript
js.configs.recommended,           // ESLint core recommended rules
...tseslint.configs.recommended,  // TypeScript parser + plugin + rules (array)
prettierRecommended,              // Prettier plugin + config-prettier (object)
```

- `tseslint.configs.recommended` is an array and must be spread
- `prettierRecommended` is a single object (no spread)
- The unified `typescript-eslint` package replaces the separate `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`

**plugins** - Only manually declare plugins not provided by config presets:

```javascript
plugins: {
  "simple-import-sort": simpleImportSort,
}
```

Note: `@typescript-eslint` and `prettier` plugins are already registered by `tseslint.configs.recommended` and `prettierRecommended` respectively.

**languageOptions** - Globals and parsing:

```javascript
languageOptions: {
  globals: {
    ...globals.node,
    ...globals.es2021,
  },
  ecmaVersion: 2020,
  sourceType: "module"
}
```

Note: The TypeScript parser is already configured by `tseslint.configs.recommended`.

**rules** - Custom rule configuration:

```javascript
rules: {
  // Prettier integration
  "prettier/prettier": ["error", {}, { usePrettierrc: true }],

  // TypeScript rules
  "@typescript-eslint/no-unused-vars": "off",
  "@typescript-eslint/explicit-function-return-type": "off",
  "@typescript-eslint/no-explicit-any": "warn",

  // Import sorting
  "simple-import-sort/imports": "error",
  "simple-import-sort/exports": "error"
}
```

### Common Rule Configurations

**Strict TypeScript:**

```javascript
rules: {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/strict-boolean-expressions": "error",
  "@typescript-eslint/no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_"
  }]
}
```

**Relaxed for Prototyping:**

```javascript
rules: {
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-unused-vars": "warn",
  "@typescript-eslint/ban-ts-comment": "off"
}
```

## Prettier Configuration

Prettier handles code formatting automatically.

### Basic Configuration

File: `.prettierrc` or in `package.json`

```json
{
  "semi": false,
  "trailingComma": "all",
  "singleQuote": false,
  "printWidth": 120,
  "tabWidth": 2,
  "endOfLine": "auto"
}
```

### Configuration Options

**semi** - Semicolons:

```json
"semi": false  // No semicolons (recommended)
"semi": true   // Always semicolons
```

**trailingComma** - Trailing commas:

```json
"trailingComma": "all"    // Everywhere possible (recommended)
"trailingComma": "es5"    // ES5 valid locations only
"trailingComma": "none"   // No trailing commas
```

**singleQuote** - Quote style:

```json
"singleQuote": false  // Double quotes (recommended)
"singleQuote": true   // Single quotes
```

**printWidth** - Line width:

```json
"printWidth": 120  // 120 characters (recommended)
"printWidth": 80   // 80 characters (traditional)
```

**tabWidth** - Indentation:

```json
"tabWidth": 2  // 2 spaces (recommended)
"tabWidth": 4  // 4 spaces
```

**endOfLine** - Line endings:

```json
"endOfLine": "auto"  // Auto-detect (recommended)
"endOfLine": "lf"    // Unix (LF)
"endOfLine": "crlf"  // Windows (CRLF)
```

### Ignore Files

Create `.prettierignore`:

```
dist
lib
node_modules
coverage
*.min.js
```

## TypeScript Configuration

TypeScript compiler configuration for strict type checking.

### Basic Configuration

File: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "lib": ["ESNext"],
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noImplicitAny": false,
    "strictPropertyInitialization": false,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "lib", "**/*.spec.ts", "**/*.test.ts"]
}
```

### Key Options Explained

**target** - JavaScript version:

```json
"target": "ESNext"    // Latest JS features
"target": "ES2020"    // Modern but stable
"target": "ES2015"    // Wider compatibility
```

**module** - Module system:

```json
"module": "ESNext"    // For bundlers (recommended)
"module": "CommonJS"  // For Node.js
"module": "NodeNext"  // For modern Node.js
```

**moduleResolution** - How modules are resolved:

```json
"moduleResolution": "bundler"  // For bundlers like tsdown (recommended)
"moduleResolution": "node"     // Node.js style
"moduleResolution": "nodenext" // Modern Node.js
```

**strict** - Strict type checking:

```json
"strict": true  // Enable all strict checks (recommended)
```

**noImplicitAny** - Implicit any errors:

```json
"noImplicitAny": false  // Pragmatic (allow some implicit any)
"noImplicitAny": true   // Strict (no implicit any)
```

**strictPropertyInitialization** - Class property initialization:

```json
"strictPropertyInitialization": false  // More flexible (recommended)
"strictPropertyInitialization": true   // Strict initialization
```

### Path Mapping

For absolute imports:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}
```

Usage:

```typescript
import { helper } from "@/utils/helper"
import { MyClass } from "@utils/MyClass"
```

## Integration Examples

### package.json Complete Example

```json
{
  "name": "my-library",
  "version": "1.0.0",
  "description": "My TypeScript library",
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
  },
  "files": ["dist", "lib"],
  "scripts": {
    "validate": "ts-builds validate",
    "format": "ts-builds format",
    "format:check": "ts-builds format:check",
    "lint": "ts-builds lint",
    "lint:check": "ts-builds lint:check",
    "test": "ts-builds test",
    "test:watch": "ts-builds test:watch",
    "test:coverage": "ts-builds test:coverage",
    "test:ui": "ts-builds test:ui",
    "build": "ts-builds build",
    "dev": "ts-builds dev",
    "prepublishOnly": "pnpm validate",
    "typecheck": "ts-builds typecheck"
  }
}
```

### Complete File Structure

```
my-library/
├── .claude/
│   └── skills/
│       └── ts-builds/
├── src/
│   ├── index.ts
│   └── utils/
├── test/
│   └── index.spec.ts
├── .gitignore
├── .prettierrc
├── eslint.config.js
├── package.json
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
├── CLAUDE.md
└── README.md
```

## Troubleshooting

### Build Issues

**Problem**: "Cannot find module"
**Solution**: Check tsdown external configuration or package.json exports

**Problem**: "Types not generated"
**Solution**: Ensure `dts: true` in tsdown.config.ts

### Test Issues

**Problem**: "Test files not found"
**Solution**: Check vitest.config.ts include patterns

**Problem**: "Coverage incomplete"
**Solution**: Review coverage.exclude and coverage.include in vitest.config.ts

### Linting Issues

**Problem**: "Parsing error"
**Solution**: Ensure `typescript-eslint` is configured correctly (parser is provided by `tseslint.configs.recommended`)

**Problem**: "Rule conflicts"
**Solution**: Make sure `prettierRecommended` (from `eslint-plugin-prettier/recommended`) is included in your config array

## Resources

- **tsdown**: https://tsdown.dev/
- **Vitest**: https://vitest.dev/
- **ESLint**: https://eslint.org/
- **Prettier**: https://prettier.io/
- **TypeScript**: https://www.typescriptlang.org/
