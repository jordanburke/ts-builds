import { Linter } from "eslint"
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

// Type-aware rules that require projectService / type-checking.
// These cannot run in the standalone Linter API, so we disable them.
const typeAwareRules: Record<string, "off"> = {
  "@typescript-eslint/no-floating-promises": "off",
  "@typescript-eslint/await-thenable": "off",
  "@typescript-eslint/no-misused-promises": "off",
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/prefer-nullish-coalescing": "off",
  "@typescript-eslint/prefer-optional-chain": "off",
  "@typescript-eslint/no-unnecessary-condition": "off",
  "@typescript-eslint/strict-boolean-expressions": "off",
  "functional/prefer-immutable-types": "off",
  "functional/immutable-data": "off",
}

// Helper to lint code with a flat config and return messages.
// Strips projectService and disables type-aware rules since the
// Linter API has no filesystem access for type-checking.
function lint(code: string, config: Linter.Config[], filename = "test.ts"): Linter.LintMessage[] {
  const linter = new Linter()
  const sanitized = config.map((c) => {
    const parserOptions = c.languageOptions?.parserOptions as Record<string, unknown> | undefined
    if (parserOptions?.projectService) {
      const { projectService, ...rest } = parserOptions
      return { ...c, languageOptions: { ...c.languageOptions, parserOptions: rest } }
    }
    return c
  })
  sanitized.push({ rules: typeAwareRules })
  return linter.verify(code, sanitized, { filename })
}

// Helper to get rule IDs from lint messages
function ruleIds(messages: Linter.LintMessage[]): string[] {
  return messages.map((m) => m.ruleId).filter((id): id is string => id !== null)
}

describe("ESLint Config Exports", () => {
  describe("ts-builds/eslint (base)", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.base.js")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include ignores config", async () => {
      const config = await import("../eslint.config.base.js")
      const ignoresConfig = config.default.find((c: { ignores?: string[] }) => c.ignores)
      expect(ignoresConfig).toBeDefined()
      expect(ignoresConfig.ignores).toContain("**/node_modules")
    })

    it("should include required plugins", async () => {
      const config = await import("../eslint.config.base.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).toHaveProperty("@typescript-eslint")
      expect(plugins).toHaveProperty("simple-import-sort")
      expect(plugins).toHaveProperty("prettier")
    })

    it("should NOT include functional plugin in base", async () => {
      const config = await import("../eslint.config.base.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).not.toHaveProperty("functional")
    })

    it("should include import-sort rules", async () => {
      const config = await import("../eslint.config.base.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("simple-import-sort/imports")
      expect(rules).toHaveProperty("simple-import-sort/exports")
    })
  })

  describe("ts-builds/eslint-fp", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.fp.js")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include functional plugin", async () => {
      const config = await import("../eslint.config.fp.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).toHaveProperty("functional")
    })

    it("should include functional rules from eslint-config-functype", async () => {
      const config = await import("../eslint.config.fp.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functional/no-let")
      expect(rules).toHaveProperty("functional/immutable-data")
    })

    it("should NOT include functype plugin", async () => {
      const config = await import("../eslint.config.fp.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).not.toHaveProperty("functype")
    })
  })

  describe("ts-builds/eslint-functype", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.functype.js")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include both functional and functype plugins", async () => {
      const config = await import("../eslint.config.functype.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).toHaveProperty("functional")
      expect(plugins).toHaveProperty("functype")
    })

    it("should include functype-specific rules", async () => {
      const config = await import("../eslint.config.functype.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functype/prefer-option")
      expect(rules).toHaveProperty("functype/prefer-either")
      expect(rules).toHaveProperty("functype/prefer-fold")
    })

    it("should also include functional rules", async () => {
      const config = await import("../eslint.config.functype.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functional/no-let")
    })
  })
})

describe("ESLint Config Linting Behavior", () => {
  describe("base config", () => {
    it("should pass clean TypeScript code", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `const greeting = "hello"\nconsole.log(greeting)\n`
      const messages = lint(code, config)
      const errors = messages.filter((m) => m.severity === 2 && m.ruleId !== "prettier/prettier")
      expect(errors).toHaveLength(0)
    })

    it("should flag unsorted imports", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `import { z } from "zod"\nimport { a } from "alpha"\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("simple-import-sort/imports")
    })

    it("should not flag sorted imports", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `import { a } from "alpha"\nimport { z } from "zod"\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).not.toContain("simple-import-sort/imports")
    })

    it("should allow unused variables (rule is off)", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `const unused = 42\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).not.toContain("@typescript-eslint/no-unused-vars")
    })

    it("should not flag undeclared variables (typescript-eslint handles this)", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `console.log(undeclaredVar)\n`
      const messages = lint(code, config)
      // no-undef is disabled by typescript-eslint because TS handles this natively
      expect(ruleIds(messages)).not.toContain("no-undef")
    })

    it("should parse TypeScript syntax without errors", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `interface Foo {\n  bar: string\n}\nconst x: Foo = { bar: "hello" }\nconsole.log(x)\n`
      const messages = lint(code, config)
      const parseErrors = messages.filter((m) => m.fatal)
      expect(parseErrors).toHaveLength(0)
    })

    it("should parse TypeScript generics and type annotations", async () => {
      const { default: config } = await import("../eslint.config.base.js")
      const code = `type Result<T> = { value: T }\nconst wrap = <T>(value: T): Result<T> => ({ value })\nconsole.log(wrap(42))\n`
      const messages = lint(code, config)
      const parseErrors = messages.filter((m) => m.fatal)
      expect(parseErrors).toHaveLength(0)
    })
  })

  describe("fp config", () => {
    it("should flag let declarations", async () => {
      const { default: config } = await import("../eslint.config.fp.js")
      const code = `let x = 1\nconsole.log(x)\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("functional/no-let")
    })

    it("should allow const declarations", async () => {
      const { default: config } = await import("../eslint.config.fp.js")
      const code = `const x = 1\nconsole.log(x)\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).not.toContain("functional/no-let")
    })

    it("should still enforce import sorting", async () => {
      const { default: config } = await import("../eslint.config.fp.js")
      const code = `import { z } from "zod"\nimport { a } from "alpha"\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("simple-import-sort/imports")
    })

    it("should parse TypeScript without errors", async () => {
      const { default: config } = await import("../eslint.config.fp.js")
      const code = `const add = (a: number, b: number): number => a + b\nconsole.log(add(1, 2))\n`
      const messages = lint(code, config)
      const parseErrors = messages.filter((m) => m.fatal)
      expect(parseErrors).toHaveLength(0)
    })
  })

  describe("functype config", () => {
    it("should flag let declarations (inherits fp rules)", async () => {
      const { default: config } = await import("../eslint.config.functype.js")
      const code = `let x = 1\nconsole.log(x)\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("functional/no-let")
    })

    it("should still enforce import sorting", async () => {
      const { default: config } = await import("../eslint.config.functype.js")
      const code = `import { z } from "zod"\nimport { a } from "alpha"\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("simple-import-sort/imports")
    })

    it("should parse TypeScript without errors", async () => {
      const { default: config } = await import("../eslint.config.functype.js")
      const code = `type Option<T> = { value: T } | { value: undefined }\nconst none: Option<string> = { value: undefined }\nconsole.log(none)\n`
      const messages = lint(code, config)
      const parseErrors = messages.filter((m) => m.fatal)
      expect(parseErrors).toHaveLength(0)
    })
  })
})
