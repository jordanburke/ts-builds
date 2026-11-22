import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ESLint, Linter } from "eslint"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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
  "@typescript-eslint/unbound-method": "off",
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

    it("should include strict TypeScript rules from eslint-config-functype", async () => {
      const config = await import("../eslint.config.fp.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("@typescript-eslint/consistent-type-imports")
      expect(rules).toHaveProperty("@typescript-eslint/no-explicit-any")
      expect(rules).toHaveProperty("prefer-const")
    })

    it("should NOT include functional or functype plugins", async () => {
      const config = await import("../eslint.config.fp.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).not.toHaveProperty("functional")
      expect(plugins).not.toHaveProperty("functype")
    })
  })

  describe("ts-builds/eslint-functype", () => {
    it("should export a valid flat config array", async () => {
      const config = await import("../eslint.config.functype.js")
      expect(Array.isArray(config.default)).toBe(true)
      expect(config.default.length).toBeGreaterThan(0)
    })

    it("should include functype plugin", async () => {
      const config = await import("../eslint.config.functype.js")
      const plugins = getAllPlugins(config.default)
      expect(plugins).not.toHaveProperty("functional")
      expect(plugins).toHaveProperty("functype")
    })

    it("should include functype-specific rules", async () => {
      const config = await import("../eslint.config.functype.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functype/prefer-option")
      expect(rules).toHaveProperty("functype/prefer-either")
      expect(rules).toHaveProperty("functype/prefer-fold")
    })

    it("should include functype-specific rules but not functional rules", async () => {
      const config = await import("../eslint.config.functype.js")
      const rules = getAllRules(config.default)
      expect(rules).toHaveProperty("functype/prefer-option")
      expect(rules).not.toHaveProperty("functional/no-let")
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
    it("should flag explicit any", async () => {
      const { default: config } = await import("../eslint.config.fp.js")
      const code = `const x: any = 1\nconsole.log(x)\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("@typescript-eslint/no-explicit-any")
    })

    it("should enforce prefer-const", async () => {
      const { default: config } = await import("../eslint.config.fp.js")
      const code = `let x = 1\nconsole.log(x)\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("prefer-const")
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
    it("should enforce prefer-const (inherits strict TS rules)", async () => {
      const { default: config } = await import("../eslint.config.functype.js")
      const code = `let x = 1\nconsole.log(x)\n`
      const messages = lint(code, config)
      expect(ruleIds(messages)).toContain("prefer-const")
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

describe("rules for test files", () => {
  const OFF = 0
  /** A rule no config mentions comes back undefined, so "not off" alone would pass for a rule that's gone. */
  const ON = [1, 2]

  const severity = async (config: Linter.Config[], file: string, rule: string): Promise<unknown> => {
    const eslint = new ESLint({ overrideConfig: config, overrideConfigFile: true })
    const resolved = (await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown> }
    const value = resolved.rules[rule]
    return Array.isArray(value) ? (value as unknown[])[0] : value
  }

  const configs = {
    "eslint.config.base.js": () => import("../eslint.config.base.js"),
    "eslint.config.fp.js": () => import("../eslint.config.fp.js"),
    "eslint.config.functype.js": () => import("../eslint.config.functype.js"),
  }
  const load = async (name: keyof typeof configs): Promise<Linter.Config[]> =>
    (await configs[name]()).default as Linter.Config[]

  const shared = ["@typescript-eslint/require-await", "@typescript-eslint/no-unnecessary-condition"]
  const functypeOnly = [
    "functype/prefer-option",
    "functype/prefer-either",
    "functype/prefer-try",
    "functype/no-floating-result",
    "functype/no-serialize-container",
    "@typescript-eslint/unbound-method",
  ]
  const testFiles = ["test/foo.spec.ts", "src/foo.test.ts", "src/__tests__/foo.ts"]

  describe.each(testFiles)("%s", (file) => {
    it.each(shared)("fp: %s is off", async (rule) => {
      expect(await severity(await load("eslint.config.fp.js"), file, rule)).toBe(OFF)
    })

    it.each([...shared, ...functypeOnly])("functype: %s is off", async (rule) => {
      expect(await severity(await load("eslint.config.functype.js"), file, rule)).toBe(OFF)
    })

    it("functype: the structural rules stay configured", async () => {
      const config = await load("eslint.config.functype.js")
      expect(ON).toContain(await severity(config, file, "functype/no-let"))
      expect(ON).toContain(await severity(config, file, "functype/no-imperative-loops"))
    })

    it("base: has no such rule to relax", async () => {
      const config = await load("eslint.config.base.js")
      for (const rule of shared) expect(await severity(config, file, rule)).toBeUndefined()
    })
  })

  describe("src/foo.ts", () => {
    it.each(shared)("fp: %s stays on", async (rule) => {
      expect(ON).toContain(await severity(await load("eslint.config.fp.js"), "src/foo.ts", rule))
    })

    it.each([...shared, ...functypeOnly])("functype: %s stays on", async (rule) => {
      expect(ON).toContain(await severity(await load("eslint.config.functype.js"), "src/foo.ts", rule))
    })
  })

  it("a consumer's block after the shared config still wins", async () => {
    const config = [
      ...(await load("eslint.config.functype.js")),
      { files: ["test/**"], rules: { "functype/prefer-option": "error" as const } },
    ]
    expect(await severity(config, "test/foo.ts", "functype/prefer-option")).toBe(2)
  })
})

describe("functype config: @typescript-eslint/unbound-method", () => {
  const RULE = "@typescript-eslint/unbound-method"

  const presets = {
    "eslint.config.base.js": () => import("../eslint.config.base.js"),
    "eslint.config.fp.js": () => import("../eslint.config.fp.js"),
    "eslint.config.functype.js": () => import("../eslint.config.functype.js"),
  }

  const resolved = async (file: string, name: keyof typeof presets): Promise<unknown> => {
    const config = (await presets[name]()).default as Linter.Config[]
    const eslint = new ESLint({ overrideConfig: config, overrideConfigFile: true })
    return ((await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown> }).rules[RULE]
  }

  it("is an error, ignoring class statics", async () => {
    expect(await resolved("src/foo.ts", "eslint.config.functype.js")).toEqual([2, { ignoreStatic: true }])
  })

  it.each(["eslint.config.base.js", "eslint.config.fp.js"] as const)("is not set by %s", async (name) => {
    expect(await resolved("src/foo.ts", name)).toBeUndefined()
  })

  /**
   * The rule needs type information, which the `lint()` helper strips, so this lints a throwaway
   * project with a tsconfig. `Box` stands in for a functype value: `orElse` uses method syntax, as
   * every functype 2.0 value type does, and `map` is an arrow-typed property, which the rule can't see.
   */
  describe("on a type-checked project", () => {
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
        },
        include: ["src/**/*"],
      }),
      "src/box.ts": [
        "export interface Box {",
        "  orElse(fallback: number): number",
        "  readonly map: (f: (n: number) => number) => Box",
        "}",
        "",
      ].join("\n"),
      "src/detached.ts": [
        'import type { Box } from "./box"',
        "declare const box: Box",
        "export const fallbacks = [1, 2].map(box.orElse)",
        "export const { orElse } = box",
        "",
      ].join("\n"),
      "src/called.ts": [
        'import type { Box } from "./box"',
        "declare const box: Box",
        "export const value = box.orElse(1)",
        "export const fallbacks = [1, 2].map((n) => box.orElse(n))",
        "",
      ].join("\n"),
      "src/arrow-property.ts": [
        'import type { Box } from "./box"',
        "declare const box: Box",
        "export const boxes = [(n: number) => n + 1].map(box.map)",
        "export const { map } = box",
        "",
      ].join("\n"),
    }

    let dir = ""
    let results: Record<string, ESLint.LintResult> = {}

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "ts-builds-unbound-method-"))
      for (const [rel, contents] of Object.entries(files)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true })
        writeFileSync(join(dir, rel), contents)
      }
      const { default: config } = (await import("../eslint.config.functype.js")) as { default: Linter.Config[] }
      const eslint = new ESLint({
        cwd: dir,
        overrideConfigFile: true,
        overrideConfig: [...config, { languageOptions: { parserOptions: { tsconfigRootDir: dir } } }],
      })
      const linted = await eslint.lintFiles(["src/*.ts"])
      results = Object.fromEntries(linted.map((r) => [r.filePath.slice(dir.length + 1), r]))
    }, 60_000)

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    const hits = (file: string): Linter.LintMessage[] =>
      (results[join("src", file)]?.messages ?? []).filter((m) => m.ruleId === RULE)

    it("type-checks every file", () => {
      expect(Object.keys(results)).toHaveLength(4)
      for (const result of Object.values(results)) expect(result.messages.filter((m) => m.fatal)).toEqual([])
    })

    it("reports a method passed or destructured without its value", () => {
      const found = hits("detached.ts")
      expect(found.map((m) => [m.line, m.severity])).toEqual([
        [3, 2],
        [4, 2],
      ])
    })

    it("stays quiet when the method is called on its value", () => {
      expect(hits("called.ts")).toEqual([])
    })

    it("misses an arrow-typed property, the rule's limit", () => {
      expect(hits("arrow-property.ts")).toEqual([])
    })
  })
})
