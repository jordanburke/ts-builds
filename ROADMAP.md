# ts-builds Roadmap

Future enhancement suggestions for ts-builds.

## Implemented

### 1. Vite Build Mode ✅

**Status**: Implemented

**Use Case**: React SPAs and applications that use Vite instead of tsdown for bundling.

**Configuration**:

```json
{
  "srcDir": "./src",
  "buildMode": "vite"
}
```

**Commands with `buildMode: "vite"`**:

- `ts-builds build` → `rimraf dist && vite build`
- `ts-builds dev` → `vite` (dev server with HMR)
- `ts-builds build:watch` → `vite build --watch`
- `ts-builds preview` → `vite preview`

**Base Config Export**: `ts-builds/vite`

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

**Peer Dependency**: `vite ^7.x` (optional)

---

## Potential Enhancements

### 2. Cloudflare Workers Support

**Status**: Not implemented

**Use Case**: Projects deploying to Cloudflare Workers that want standardized lint/format/test but use Wrangler for builds.

**Proposed Implementation**:

- Add `platform` config option: `"node"` (default) | `"cloudflare-worker"`
- When `platform: "cloudflare-worker"`:
  - Keep lint/format/test/typecheck unchanged
  - `ts-builds build` runs `tsc --build && tsc-alias` (not tsdown)
  - Add `ts-builds deploy` command → `wrangler deploy`
  - Add `ts-builds dev` → `wrangler dev`
- Export Wrangler-compatible tsconfig: `ts-builds/tsconfig-workers`

**Config Example**:

```json
{
  "srcDir": "./src",
  "platform": "cloudflare-worker",
  "commands": {
    "deploy:dev": "wrangler deploy --env development",
    "deploy:prod": "wrangler deploy --env production"
  }
}
```

**Dependencies**: Would need `wrangler` as optional peer dependency.

---

### 3. Monorepo Support

**Status**: Partially supported via custom commands

**Use Case**: pnpm/npm workspaces with multiple packages needing coordinated builds.

**Proposed Implementation**:

- Add `monorepo` config section for package build order
- Support `cwd` in custom commands (already works)
- Add parallel execution for independent packages

**Config Example**:

```json
{
  "monorepo": {
    "packages": ["shared", "shared-ui", "app"],
    "buildOrder": [["shared"], ["shared-ui"], ["app"]]
  },
  "chains": {
    "build:all": ["build:shared", "build:shared-ui", "build:app"]
  }
}
```

---

## Current Workaround

Cloudflare Workers and monorepo support can be achieved using custom commands:

```json
{
  "srcDir": "./src",
  "commands": {
    "build:workers": "tsc --build && tsc-alias",
    "deploy": "wrangler deploy",
    "dev:workers": "wrangler dev"
  },
  "chains": {
    "validate": ["format", "lint", "typecheck", "test", "build:workers"]
  }
}
```

This works well - native support would just be cleaner and more discoverable.

---

## Priority

1. ~~**Vite mode** - High value, many SPAs use Vite~~ ✅ Implemented
2. **Monorepo support** - Medium value, custom commands work fine
3. **Cloudflare Workers** - Lower priority, niche use case, custom commands sufficient
