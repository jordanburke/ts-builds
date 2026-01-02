# ts-builds Roadmap

Future enhancement suggestions for ts-builds.

## Potential Enhancements

### 1. Vite Build Mode

**Status**: Documented in `package-scripts.json` as variants, not yet wired up

**Use Case**: React SPAs and applications that use Vite instead of tsdown for bundling.

**Proposed Implementation**:

- Add `buildMode` config option: `"tsdown"` (default) | `"vite"`
- When `buildMode: "vite"`:
  - `ts-builds build` runs `vite build`
  - `ts-builds dev` runs `vite dev` (with HMR)
- Export base Vite config: `ts-builds/vite`

**Config Example**:

```json
{
  "srcDir": "./src",
  "buildMode": "vite"
}
```

**CLI Changes**:

```typescript
// In cli.ts builtinCommands
build: config.buildMode === "vite"
  ? { run: "rimraf dist && vite build" }
  : { run: "rimraf dist && cross-env NODE_ENV=production tsdown" },
```

---

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

All of the above can be achieved TODAY using custom commands in `ts-builds.config.json`:

```json
{
  "srcDir": "./src",
  "commands": {
    "build:vite": "vite build",
    "build:workers": "tsc --build && tsc-alias",
    "deploy": "wrangler deploy",
    "dev:vite": "vite dev",
    "dev:workers": "wrangler dev"
  },
  "chains": {
    "validate": ["format", "lint", "typecheck", "test", "build:workers"]
  }
}
```

This works well - the native support would just be cleaner and more discoverable.

---

## Priority

1. **Vite mode** - High value, many SPAs use Vite
2. **Monorepo support** - Medium value, custom commands work fine
3. **Cloudflare Workers** - Lower priority, niche use case, custom commands sufficient
