# typescript-template-configs

[![Validate Configs Package](https://github.com/jordanburke/typescript-template-configs/actions/workflows/node.js.yml/badge.svg)](https://github.com/jordanburke/typescript-template-configs/actions/workflows/node.js.yml)

Shared TypeScript configuration files for library templates. Provides standardized ESLint, Prettier, Vitest, TypeScript, and build configs.

## 📦 What's Included

This package provides base configuration files for TypeScript library templates:

### Locked Configs (Use As-Is)

- **`.prettierrc`** - Code formatting rules
- **`.prettierignore`** - Files to ignore from formatting

### Extendable Configs (Can Be Customized)

- **`eslint.config.base.mjs`** - Base ESLint rules + TypeScript support
- **`vitest.config.base.ts`** - Vitest test framework configuration
- **`tsconfig.base.json`** - TypeScript compiler base settings
- **`tsup.config.base.ts`** - Build configuration for tsup
- **`package-scripts.json`** - Standardized npm scripts reference

## 🚀 Installation

```bash
pnpm add -D typescript-template-configs

# Also install peer dependencies:
pnpm add -D \
  eslint prettier typescript vitest tsup \
  @typescript-eslint/eslint-plugin @typescript-eslint/parser \
  eslint-config-prettier eslint-plugin-prettier \
  eslint-plugin-import eslint-plugin-simple-import-sort \
  @eslint/js @eslint/eslintrc globals \
  @vitest/coverage-v8 cross-env rimraf
```

## 🛠️ Quick Setup (CLI)

After installation, run the CLI to generate required config files:

```bash
npx typescript-template-configs
```

This creates:
- `.npmrc` - Configures pnpm to hoist CLI binaries from peer dependencies

**For local development** (testing before publishing):
```bash
# From within this project
node bin/init.js

# Or link globally first
pnpm link --global
typescript-template-configs
```

## 📖 Usage

### Prettier (Locked - Use Exact Copy)

Copy the Prettier config to your project root:

```bash
cp node_modules/typescript-template-configs/.prettierrc .
cp node_modules/typescript-template-configs/.prettierignore .
```

Or reference it in your `package.json`:

```json
{
  "prettier": "typescript-template-configs/prettier"
}
```

### ESLint (Extendable)

**Basic usage (inherit all base rules):**

```javascript
// eslint.config.mjs
import baseConfig from "typescript-template-configs/eslint"

export default [...baseConfig]
```

**Extended usage (add variant-specific rules):**

```javascript
// eslint.config.mjs
import baseConfig from "typescript-template-configs/eslint"

export default [
  ...baseConfig,
  {
    // React-specific rules
    files: ["**/*.tsx"],
    rules: {
      "react/jsx-uses-react": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
]
```

### Vitest (Extendable)

**Basic usage:**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config"
import baseConfig from "typescript-template-configs/vitest"

export default defineConfig(baseConfig)
```

**Extended usage:**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config"
import baseConfig from "typescript-template-configs/vitest"

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: ["./test/setup.ts"], // Add custom setup
  },
})
```

### TypeScript (Extendable)

**Basic usage:**

```json
{
  "extends": "typescript-template-configs/tsconfig",
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

**Extended usage:**

```json
{
  "extends": "typescript-template-configs/tsconfig",
  "compilerOptions": {
    "outDir": "./dist",
    "jsx": "react-jsx",
    "lib": ["ES2020", "DOM"]
  }
}
```

### Tsup (Extendable)

**Basic usage:**

```typescript
// tsup.config.ts
import baseConfig from "typescript-template-configs/tsup"

export default baseConfig
```

**Extended usage (customize entry points):**

```typescript
// tsup.config.ts
import baseConfig from "typescript-template-configs/tsup"
import type { Options } from "tsup"

export default {
  ...baseConfig,
  entry: ["src/index.ts", "src/cli.ts"], // Multiple entry points
} satisfies Options
```

### Package Scripts (Reference Only)

The `package-scripts.json` file contains standardized npm scripts. Copy the relevant scripts to your `package.json`:

```json
{
  "scripts": {
    "validate": "pnpm format && pnpm lint && pnpm test && pnpm build",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint ./src --fix",
    "lint:check": "eslint ./src",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui",
    "build": "rimraf dist && cross-env NODE_ENV=production tsup",
    "build:watch": "tsup --watch",
    "dev": "tsup --watch",
    "prepublishOnly": "pnpm validate",
    "ts-types": "tsc"
  }
}
```

## 🔄 Update Workflow

When configs are updated in this package, update your template:

```bash
# Update to latest version
pnpm update typescript-template-configs

# Re-copy locked files (Prettier)
cp node_modules/typescript-template-configs/.prettierrc .
cp node_modules/typescript-template-configs/.prettierignore .

# Test that everything still works
pnpm validate
```

## 🎯 Design Philosophy

### Locked vs Extendable

**Locked files** ensure consistency across all templates:

- **Prettier** - Code formatting should be identical everywhere
- Prevents formatting debates and merge conflicts

**Extendable files** allow variant-specific customization:

- **ESLint** - Different variants need different rules (React, Node.js, etc.)
- **Vitest** - Some variants need custom test setup
- **TypeScript** - Browser vs Node targets, JSX support, etc.
- **Build configs** - Different entry points, output formats

### Semantic Versioning

This package follows semver:

- **Patch** (1.0.x) - Bug fixes in configs
- **Minor** (1.x.0) - New configs added, backward compatible
- **Major** (x.0.0) - Breaking changes to existing configs

## 📚 Available Template Variants

Templates using these configs:

- **[typescript-library-template](https://github.com/jordanburke/typescript-library-template)** - Base template (tsup)
- **typescript-library-template-vite** - Vite-based variant (coming soon)
- **typescript-library-template-react** - React library variant (coming soon)

## 🤝 Contributing

Found a bug or want to improve the configs?

1. Fork this repository
2. Make your changes
3. Test in a template project
4. Submit a PR with explanation

## 📄 License

MIT © Jordan Burke

## 🔗 Related

- [STANDARDIZATION_GUIDE.md](./STANDARDIZATION_GUIDE.md) - How to apply this pattern
- [package-scripts.json](./package-scripts.json) - Script reference documentation
