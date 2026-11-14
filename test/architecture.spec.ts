import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Linter } from "eslint"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ArchitectureError, defineArchitecture, type ArchitectureInput } from "../src/architecture"
import { denySources, noBoundariesDisable, typedPackages } from "../src/eslint-boundaries"
import { describeFinding, DENY_MESSAGE, EXPECTED, type Finding, lintFixture as lintFrom } from "./architecture-expected"

/**
 * The on-disk pnpm fixture in test/fixtures/architecture is linted through the built
 * package (`ts-builds/eslint-boundaries` resolves to dist/), so this spec runs after
 * the build, as validate:bootstrap does. Each lint runs in a child process with a real
 * working directory, because the plugin's silent passes depend on process.cwd(), which
 * an in-process ESLint `cwd` option does not change.
 */
const fixture = join(process.cwd(), "test", "fixtures", "architecture")
const WORKSPACE_DIRS = ["packages/types", "packages/rules", "packages/db", "packages/shared", "apps/api"]

const lintFixture = (cwd: string, probe?: "--classify" | "--cwd-root"): Finding[] => lintFrom(fixture, cwd, probe)
const summary = (findings: Finding[]): string[] => findings.map((f) => `${f.file}:${f.line} ${f.rule}`)

/** The root run's findings for files under `cwd`: what a run from `cwd` must report. */
const under = (findings: Finding[], cwd: string): Finding[] =>
  findings.filter((f) => cwd === "." || f.file.startsWith(`${cwd}/`))

describe("architecture boundaries on the pnpm fixture", () => {
  let rootFindings: Finding[] = []

  beforeAll(() => {
    // A failed install must fail the suite: this fixture is the only proof the pinned
    // plugin and resolver still behave, so it must never be skipped.
    const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: fixture,
      encoding: "utf-8",
    })
    if (install.status !== 0) {
      throw new Error(`pnpm install in the fixture failed:\n${install.stdout}\n${install.stderr}`)
    }
    rootFindings = lintFixture(".")
  }, 120_000)

  it("reports exactly the seeded violations, each once", () => {
    expect(rootFindings.map(describeFinding)).toEqual(EXPECTED)
  })

  it("names the policy and its reason in a deny finding", () => {
    const denied = rootFindings.filter((f) => f.message === DENY_MESSAGE)
    expect(denied.map((f) => f.file)).toContain("packages/rules/src/violations/denied-glob.ts")
  })

  it.each(["packages/rules", "packages/rules/src", "apps/api"])(
    "gives the same findings for its files when run from %s",
    (cwd) => {
      const expected = under(rootFindings, cwd)
      expect(expected.length).toBeGreaterThan(0)
      expect(lintFixture(cwd)).toEqual(expected)
    },
    60_000,
  )

  it("breaks without an absolute root-path when run from a workspace (harness check)", () => {
    // The plugin's default root-path is process.cwd(). If this run matched the root
    // run, the child processes would not really be changing directory.
    const findings = lintFixture("packages/rules", "--cwd-root")
    expect(summary(findings)).not.toEqual(summary(rootFindings))
    expect(findings.some((f) => f.rule === "boundaries/no-unknown-files")).toBe(true)
  }, 60_000)

  it("classifies every import the same way", () => {
    // Every import reports how the plugin classified its target. A resolver or plugin
    // change that flips a workspace import to external, or loses one, changes this.
    const classified = lintFixture(".", "--classify").map((f) => `${f.file}:${f.line} ${f.message}`)
    expect(classified).toMatchSnapshot()
  }, 60_000)

  describe("with workspace configs that re-export the root config", () => {
    beforeAll(() => {
      WORKSPACE_DIRS.forEach((dir) =>
        writeFileSync(join(fixture, dir, "eslint.config.mjs"), 'export { default } from "../../eslint.config.mjs"\n'),
      )
    })

    afterAll(() => {
      WORKSPACE_DIRS.forEach((dir) => rmSync(join(fixture, dir, "eslint.config.mjs"), { force: true }))
    })

    it.each([".", "packages/rules", "apps/api"])(
      "gives the same findings when run from %s",
      (cwd) => {
        expect(lintFixture(cwd)).toEqual(under(rootFindings, cwd))
      },
      60_000,
    )
  })
})

describe("defineArchitecture", () => {
  const FIXTURE_POLICY: ArchitectureInput["workspaces"] = {
    "@fx/types": { dir: "packages/types", type: "pure" },
    "@fx/rules": { dir: "packages/rules", type: "pure", allow: ["@fx/types"], deny: ["db-client", "@ai/*"] },
    "@fx/db": { dir: "packages/db", type: "infra" },
    "@fx/shared": { dir: "packages/shared", type: "lib", allow: ["@fx/db"] },
    "@fx/api": { dir: "apps/api", type: "app", allow: ["@fx/*"] },
  }

  const problemsOf = (input: ArchitectureInput): readonly string[] => {
    try {
      defineArchitecture(input)
    } catch (error) {
      if (error instanceof ArchitectureError) return error.problems
      throw error
    }
    throw new Error("expected defineArchitecture to throw")
  }

  it("resolves allowed workspaces, declared externals and tsconfigs", () => {
    const { workspaces } = defineArchitecture({ rootDir: fixture, workspaces: FIXTURE_POLICY })
    const rules = workspaces["@fx/rules"]
    expect(rules?.allowedWorkspaces).toEqual(["@fx/types"])
    expect(rules?.dependencies).toEqual(["db-client", "@ai/openai"])
    expect(rules?.devDependencies).toEqual(["test-helper", "@types/typed-lib"])
    expect(rules?.tsconfig).toBe(join(fixture, "packages/rules/tsconfig.json"))
    expect(workspaces["@fx/api"]?.allowedWorkspaces).toEqual(["@fx/types", "@fx/rules", "@fx/db", "@fx/shared"])
  })

  it("throws for a relative rootDir", () => {
    expect(problemsOf({ rootDir: "test/fixtures/architecture", workspaces: FIXTURE_POLICY })).toEqual([
      'rootDir "test/fixtures/architecture" must be an absolute path. Pass import.meta.dirname',
    ])
  })

  it("throws for a rootDir with no pnpm-workspace.yaml", () => {
    const dir = join(fixture, "packages")
    expect(problemsOf({ rootDir: dir, workspaces: FIXTURE_POLICY })).toEqual([
      `rootDir ${dir} holds no pnpm-workspace.yaml`,
    ])
  })

  it("throws for a listed workspace with no policy", () => {
    const { "@fx/api": _api, ...rest } = FIXTURE_POLICY
    expect(problemsOf({ rootDir: fixture, workspaces: rest })).toEqual([
      "apps/api is a workspace (@fx/api) with no policy",
    ])
  })

  it("throws for a pure workspace that allows an impure one", () => {
    const rules = { ...FIXTURE_POLICY["@fx/rules"]!, allow: ["@fx/types", "@fx/shared"] }
    expect(problemsOf({ rootDir: fixture, workspaces: { ...FIXTURE_POLICY, "@fx/rules": rules } })).toEqual([
      '@fx/rules is pure, but allow entry "@fx/shared" reaches @fx/shared, which is "lib"',
    ])
  })

  it("throws for an allow entry that matches no workspace", () => {
    const shared = { ...FIXTURE_POLICY["@fx/shared"]!, allow: ["@fx/database"] }
    expect(problemsOf({ rootDir: fixture, workspaces: { ...FIXTURE_POLICY, "@fx/shared": shared } })).toEqual([
      '@fx/shared: allow entry "@fx/database" matches no other workspace',
    ])
  })

  it("throws for a dir that is not a listed workspace, or a name that differs", () => {
    const workspaces = {
      ...FIXTURE_POLICY,
      "@fx/db": { dir: "vendor/db-client", type: "infra" },
      "@fx/wrong": { dir: "packages/db", type: "infra" },
    }
    expect(problemsOf({ rootDir: fixture, workspaces })).toEqual([
      '@fx/db: dir "vendor/db-client" is not a workspace the root\'s pnpm-workspace.yaml lists',
      '@fx/wrong: packages/db/package.json is named "@fx/db", not "@fx/wrong"',
    ])
  })

  it("throws for a deny entry that matches a workspace, which the plugin would ignore", () => {
    const api = { ...FIXTURE_POLICY["@fx/api"]!, deny: ["@fx/db"] }
    expect(problemsOf({ rootDir: fixture, workspaces: { ...FIXTURE_POLICY, "@fx/api": api } })).toEqual([
      '@fx/api: deny entry "@fx/db" matches the workspace @fx/db. deny is for external packages; leave a workspace out of allow instead',
    ])
  })

  /** A scratch workspace root: `files` maps a path to its contents. */
  function scratchRoot(files: Record<string, string>, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "ts-builds-architecture-"))
    try {
      Object.entries(files).forEach(([path, contents]) => {
        mkdirSync(join(root, path, ".."), { recursive: true })
        writeFileSync(join(root, path), contents)
      })
      run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it("throws for a workspace with no src directory", () => {
    const files = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
      "packages/a/lib/index.ts": "",
    }
    scratchRoot(files, (root) => {
      expect(problemsOf({ rootDir: root, workspaces: { "@x/a": { dir: "packages/a", type: "lib" } } })).toEqual([
        "@x/a: packages/a has no src directory. Boundary rules check src and test, so code elsewhere is unchecked",
      ])
    })
  })

  it.each([
    ["on one line", "packages: ['packages/*', \"apps/*\"]\n"],
    ["over several lines", "packages: [\n  'packages/*',\n  \"apps/*\",\n]\nminimumReleaseAge: 1440\n"],
  ])("reads a flow-style packages list %s", (_label, yaml) => {
    const files = {
      "pnpm-workspace.yaml": yaml,
      "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
      "packages/a/src/index.ts": "",
    }
    scratchRoot(files, (root) => {
      const { workspaces } = defineArchitecture({
        rootDir: root,
        workspaces: { "@x/a": { dir: "packages/a", type: "lib" } },
      })
      expect(Object.keys(workspaces)).toEqual(["@x/a"])
    })
  })

  it("throws for a root whose pnpm-workspace.yaml lists no packages", () => {
    scratchRoot({ "pnpm-workspace.yaml": "minimumReleaseAge: 1440\n" }, (root) => {
      expect(problemsOf({ rootDir: root, workspaces: {} })).toEqual([
        `${join(root, "pnpm-workspace.yaml")} has no packages: list, so it is not a monorepo root`,
      ])
    })
  })

  it("reports an unreadable package.json as a problem, not a raw SyntaxError", () => {
    const files = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": "{ not json",
      "packages/a/src/index.ts": "",
    }
    scratchRoot(files, (root) => {
      const problems = problemsOf({ rootDir: root, workspaces: { "@x/a": { dir: "packages/a", type: "lib" } } })
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatch(/^packages\/a\/package\.json can't be read: /)
    })
  })

  it("throws a clear error when workspaces is missing", () => {
    expect(problemsOf({ rootDir: fixture } as unknown as ArchitectureInput)).toEqual([
      "workspaces is required: map each workspace package name to its policy",
    ])
  })
})

describe("deny and @types helpers", () => {
  it("adds the other spelling of a denied core module, including through a glob", () => {
    expect(denySources(["fs", "node:child_process", "pg"])).toEqual(
      expect.arrayContaining(["fs", "node:fs", "child_process", "node:child_process", "pg"]),
    )
    expect(denySources(["node:o*"])).toEqual(expect.arrayContaining(["os", "node:os"]))
    expect(denySources(["@ai-sdk/*"])).toEqual(["@ai-sdk/*"])
  })

  it("maps @types packages to the packages they describe", () => {
    expect(typedPackages(["@types/lodash", "@types/babel__core", "react"])).toEqual(["lodash", "@babel/core"])
  })
})

describe("no-boundaries-disable", () => {
  const lint = (code: string): Array<{ line: number; messageId: string | undefined }> =>
    new Linter()
      .verify(code, {
        plugins: { "ts-builds": { rules: { "no-boundaries-disable": noBoundariesDisable } } },
        rules: { "ts-builds/no-boundaries-disable": "error" },
      })
      .filter((m) => m.ruleId === "ts-builds/no-boundaries-disable")
      .map((m) => ({ line: m.line, messageId: m.messageId }))

  it.each([
    ["next-line", "// eslint-disable-next-line boundaries/dependencies\nconst a = 1"],
    ["same line, with a reason", "const a = 1 // eslint-disable-line boundaries/dependencies -- legacy"],
    ["block", "/* eslint-disable boundaries/dependencies */\nconst a = 1"],
    ["listed with other rules", "// eslint-disable-next-line no-console, boundaries/no-unknown-files\nconst a = 1"],
  ])("reports a named boundaries disable: %s", (_label, code) => {
    expect(lint(code)).toEqual([{ line: 1, messageId: "named" }])
  })

  it("reports a blanket disable below the first line at line 1, where it can't be silenced", () => {
    expect(lint("const a = 1\n/* eslint-disable */\nconst b = 2")).toEqual([{ line: 1, messageId: "blanket" }])
  })

  it.each([
    ["a config comment turning a boundaries rule off", 'const a = 1\n/* eslint boundaries/dependencies: "off" */', 2],
    ["a config comment with a double-quoted name", 'const a = 1\n/* eslint "boundaries/dependencies": "off" */', 2],
    ["a config comment with a single-quoted name", "const a = 1\n/* eslint 'boundaries/dependencies': 'off' */", 2],
    [
      "a config comment with a quoted name second in the list",
      'const a = 1\n/* eslint no-console: "off", "boundaries/dependencies": "off" */',
      2,
    ],
    [
      "a config comment with no comma between entries",
      'const a = 1\n/* eslint no-console: 0 "boundaries/dependencies": 0 */',
      2,
    ],
    [
      "a config comment with unquoted entries and no comma",
      "const a = 1\n/* eslint no-console: 0 boundaries/dependencies: 0 */",
      2,
    ],
    [
      "a config comment split over lines with no comma",
      "const a = 1\n/* eslint no-console: 0\n  boundaries/dependencies: 0 */\nconst b = 2",
      2,
    ],
    [
      "a config comment after an array value",
      'const a = 1\n/* eslint no-console: [0] "boundaries/dependencies": 0 */',
      2,
    ],
    ["a config comment wrapped in braces", 'const a = 1\n/* eslint {"boundaries/dependencies": 0} */', 2],
    [
      "a mid-file block disable naming only this rule",
      "const a = 1\n/* eslint-disable ts-builds/no-boundaries-disable */\nconst b = 2",
      1,
    ],
    [
      "a next-line disable naming only this rule",
      "const a = 1\n// eslint-disable-next-line ts-builds/no-boundaries-disable\nconst b = 2",
      2,
    ],
    [
      "a same-line disable that also names this rule",
      "const a = 1 // eslint-disable-line boundaries/dependencies, ts-builds/no-boundaries-disable\nconst b = 2",
      2,
    ],
    [
      "a mid-file block disable that also names this rule",
      "const a = 1\n/* eslint-disable boundaries/dependencies, ts-builds/no-boundaries-disable */\nconst b = 2",
      1,
    ],
  ])("reports %s on a line the comment doesn't cover", (_label, code, line) => {
    expect(lint(code)).toEqual([{ line, messageId: "named" }])
  })

  it("reports a blanket same-line disable on line 1 at line 2", () => {
    expect(lint("const a = 1 // eslint-disable-line\nconst b = 2")).toEqual([{ line: 2, messageId: "blanket" }])
  })

  it.each([
    ["a blanket block disable at the very start of a file", "/* eslint-disable */\nconst a = 1"],
    ["a config comment that turns this rule itself off", '/* eslint ts-builds/no-boundaries-disable: "off" */'],
    [
      "a same-line disable naming this rule in a one-line file",
      "const a = 1 // eslint-disable-line ts-builds/no-boundaries-disable",
    ],
  ])("can't report %s (a known limit)", (_label, code) => {
    expect(lint(code)).toEqual([])
  })

  it("leaves a disable of an unrelated rule alone", () => {
    expect(lint("// eslint-disable-next-line no-console\nconsole.log(1)")).toEqual([])
  })
})
