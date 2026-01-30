import { describe, expect, it } from "vitest"

// Helper to collect all plugins from a flat config array
function getAllPlugins(configArray: Array<{ plugins?: Record<string, unknown> }>): Record<string, unknown> {
  return configArray.reduce(
    (acc, config) => {
      if (config.plugins) {
        Object.assign(acc, config.plugins)
      }
      return acc
    },
    {} as Record<string, unknown>,
  )
}

// Helper to collect all rules from a flat config array
function getAllRules(configArray: Array<{ rules?: Record<string, unknown> }>): Record<string, unknown> {
  return configArray.reduce(
    (acc, config) => {
      if (config.rules) {
        Object.assign(acc, config.rules)
      }
      return acc
    },
    {} as Record<string, unknown>,
  )
}

describe("ESLint Config Exports", () => {
  describe("ts-builds/eslint (base)", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.base.mjs")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include ignores config", async () => {
      const config = await import("../eslint.config.base.mjs")
      const ignoresConfig = config.default.find((c: { ignores?: string[] }) => c.ignores)
      expect(ignoresConfig).toBeDefined()
      expect(ignoresConfig.ignores).toContain("**/node_modules")
    })

    it("should include required plugins", async () => {
      const config = await import("../eslint.config.base.mjs")
      const plugins = getAllPlugins(config.default)
      expect(plugins).toHaveProperty("@typescript-eslint")
      expect(plugins).toHaveProperty("simple-import-sort")
      expect(plugins).toHaveProperty("prettier")
    })

    it("should NOT include functional plugin in base", async () => {
      const config = await import("../eslint.config.base.mjs")
      const plugins = getAllPlugins(config.default)
      expect(plugins).not.toHaveProperty("functional")
    })

    it("should include import-sort rules", async () => {
      const config = await import("../eslint.config.base.mjs")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("simple-import-sort/imports")
      expect(rules).toHaveProperty("simple-import-sort/exports")
    })
  })

  describe("ts-builds/eslint-fp", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.fp.mjs")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include functional plugin", async () => {
      const config = await import("../eslint.config.fp.mjs")
      const plugins = getAllPlugins(config.default)
      expect(plugins).toHaveProperty("functional")
    })

    it("should include functional rules from eslint-config-functype", async () => {
      const config = await import("../eslint.config.fp.mjs")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functional/no-let")
      expect(rules).toHaveProperty("functional/immutable-data")
    })

    it("should NOT include functype plugin", async () => {
      const config = await import("../eslint.config.fp.mjs")
      const plugins = getAllPlugins(config.default)
      expect(plugins).not.toHaveProperty("functype")
    })
  })

  describe("ts-builds/eslint-functype", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.functype.mjs")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include both functional and functype plugins", async () => {
      const config = await import("../eslint.config.functype.mjs")
      const plugins = getAllPlugins(config.default)
      expect(plugins).toHaveProperty("functional")
      expect(plugins).toHaveProperty("functype")
    })

    it("should include functype-specific rules", async () => {
      const config = await import("../eslint.config.functype.mjs")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functype/prefer-option")
      expect(rules).toHaveProperty("functype/prefer-either")
      expect(rules).toHaveProperty("functype/prefer-fold")
    })

    it("should also include functional rules", async () => {
      const config = await import("../eslint.config.functype.mjs")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functional/no-let")
    })
  })
})
