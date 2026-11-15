import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Linter } from "eslint"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ArchitectureError,
  defineArchitecture,
  type ArchitectureInput,
  type WorkspacePolicy,
} from "../src/architecture"
import {
  asDirectiveSource,
  createBoundaries,
  denySources,
  noBoundariesDisable,
  ROOT_FILE_CATEGORY,
  typedPackages,
} from "../src/eslint-boundaries"
import { describeFinding, DENY_MESSAGE, EXPECTED, type Finding, lintFixture as lintFrom } from "./architecture-expected"

/**
 * The on-disk pnpm fixture in test/fixtures/architecture is linted through the built
 * package (`ts-builds/eslint-boundaries` resolves to dist/), so this spec runs after
 * the build, as validate:bootstrap does. Each lint runs in a child process with a real
 * working directory, because the plugin's silent passes depend on process.cwd(), which
 * an in-process ESLint `cwd` option does not change.
 */
const fixture = join(process.cwd(), "test", "fixtures", "architecture")

// Whether this filesystem opens a path in any case (macOS and Windows defaults).
const caseInsensitive = existsSync(join(process.cwd(), "PACKAGE.JSON"))

// The fixture's workspaces without its ownDirs and testPolicy, for tests that build their own.
const FIXTURE_WORKSPACES: ArchitectureInput["workspaces"] = {
  "@fx/types": { dir: "packages/types", type: "pure" },
  "@fx/rules": { dir: "packages/rules", type: "pure", allow: ["@fx/types"], deny: ["db-client", "@ai/*"] },
  "@fx/db": { dir: "packages/db", type: "infra" },
  "@fx/shared": { dir: "packages/shared", type: "lib", allow: ["@fx/db"] },
  "@fx/api": { dir: "apps/api", type: "app", allow: ["@fx/*"] },
}
const WORKSPACE_DIRS = ["packages/types", "packages/rules", "packages/db", "packages/shared", "apps/api"]

const lintFixture = (cwd: string, probe?: "--classify" | "--cwd-root"): Finding[] => lintFrom(fixture, cwd, probe)
const summary = (findings: Finding[]): string[] => findings.map((f) => `${f.file}:${f.line} ${f.rule}`)

/** The root run's findings for files under `cwd`: what a run from `cwd` must report. */
const under = (findings: Finding[], cwd: string): Finding[] =>
  findings.filter((f) => cwd === "." || f.file.startsWith(`${cwd}/`))

describe("architecture boundaries on the pnpm fixture", () => {
  let rootFindings: Finding[] = []

  beforeAll(() => {
    // test/setup-fixtures.ts has installed the fixture.
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

describe("messages for a local file outside every workspace", () => {
  const messageFor = (findings: Finding[], file: string): string | undefined =>
    findings.find((finding) => finding.file === file)?.message

  it("names the target and the option that allows it, by importer", () => {
    const findings = lintFixture(".")
    expect(messageFor(findings, "packages/rules/src/violations/unlisted-sibling.ts")).toBe(
      "@fx/rules (pure) imports packages/rules/other/unlisted.json, a file outside every workspace's src and test. " +
        "To allow a folder of @fx/rules beside src, list it in its ownDirs",
    )
    expect(messageFor(findings, "packages/rules/test/imports-unlisted-root.ts")).toBe(
      "@fx/rules (pure) test imports scripts/helper.ts, a file outside every workspace's src and test. " +
        "To allow a folder of @fx/rules beside src, list it in its ownDirs; to allow a repo file outside every " +
        "workspace, list it in testPolicy.allowRootFiles",
    )
    expect(messageFor(findings, "packages/shared/src/unresolved-local.ts")).toBe(
      "@fx/shared (lib) imports ./does-not-exist.ts, a local path that doesn't resolve",
    )
  }, 60_000)

  it("allows an allowRootFiles file only from test files, and only while it is in no element", () => {
    const architecture = defineArchitecture({
      rootDir: fixture,
      workspaces: { ...FIXTURE_WORKSPACES, "@fx/rules": { ...FIXTURE_WORKSPACES["@fx/rules"], ownDirs: ["data"] } },
      testPolicy: { allowRootFiles: ["tooling.config.mjs"] },
    })
    const { policies, settings } = createBoundaries(architecture)
    const rootFileAllows = policies.filter((policy) => JSON.stringify(policy.allow ?? {}).includes(ROOT_FILE_CATEGORY))
    expect(rootFileAllows).toHaveLength(Object.keys(FIXTURE_WORKSPACES).length)
    rootFileAllows.forEach((policy) => {
      expect(policy.from).toMatchObject({ file: { categories: ["test"] } })
      expect(policy.allow).toEqual({
        to: { element: { isUnknown: true }, module: { origin: "local" }, file: { categories: [ROOT_FILE_CATEGORY] } },
      })
    })
    expect(settings["boundaries/files"]).toContainEqual({ pattern: "tooling.config.mjs", category: ROOT_FILE_CATEGORY })
    expect(settings["boundaries/elements"]).toContainEqual({
      type: "@fx/rules:ownDirs",
      pattern: "packages/rules/data",
    })
  })
})

describe("defineArchitecture", () => {
  const FIXTURE_POLICY: ArchitectureInput["workspaces"] = FIXTURE_WORKSPACES
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

  // A minimal workspace for the ownDirs and allowRootFiles cases below.
  const ONE_WORKSPACE = {
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
    "packages/a/src/index.ts": "",
  }
  const policyOf = (
    root: string,
    extra: Partial<WorkspacePolicy> = {},
    testPolicy: ArchitectureInput["testPolicy"] = {},
  ): ArchitectureInput => ({
    rootDir: root,
    workspaces: { "@x/a": { dir: "packages/a", type: "lib", ...extra } },
    testPolicy,
  })

  it("resolves ownDirs to normalized workspace-relative folders", () => {
    scratchRoot({ ...ONE_WORKSPACE, "packages/a/drizzle/meta/_journal.json": "{}" }, (root) => {
      const { workspaces } = defineArchitecture(policyOf(root, { ownDirs: ["drizzle/", "./drizzle/meta", "drizzle"] }))
      expect(workspaces["@x/a"]?.ownDirs).toEqual(["drizzle", "drizzle/meta"])
    })
  })

  it.each([
    ["a missing folder", "drizzle", '@x/a: ownDirs entry "drizzle": packages/a/drizzle is not a folder'],
    ["the workspace itself", ".", '@x/a: ownDirs entry "." must be a folder inside packages/a, relative to it'],
    ["an empty entry", " ", '@x/a: ownDirs entry " " must be a folder inside packages/a, relative to it'],
    ["a parent folder", "../b", '@x/a: ownDirs entry "../b" must be a folder inside packages/a, relative to it'],
    ["an absolute path", "/tmp", '@x/a: ownDirs entry "/tmp" must be a folder inside packages/a, relative to it'],
    ["src", "src", '@x/a: ownDirs entry "src" is inside src, which the boundary rules already check'],
    [
      "a folder under test",
      "test/data",
      '@x/a: ownDirs entry "test/data" is inside test, which the boundary rules already check',
    ],
    ["node_modules", "node_modules/x", '@x/a: ownDirs entry "node_modules/x" is under node_modules'],
    ["a glob", "data/*", '@x/a: ownDirs entry "data/*" must be a plain folder path, with none of * ? [ ] { } ( ) ! \\'],
    [
      "a group",
      "da(ta)",
      '@x/a: ownDirs entry "da(ta)" must be a plain folder path, with none of * ? [ ] { } ( ) ! \\',
    ],
    [
      "a class",
      "da[ta]",
      '@x/a: ownDirs entry "da[ta]" must be a plain folder path, with none of * ? [ ] { } ( ) ! \\',
    ],
  ])("throws for an ownDirs entry that is %s", (_label, entry, problem) => {
    scratchRoot(ONE_WORKSPACE, (root) => {
      expect(problemsOf(policyOf(root, { ownDirs: [entry] }))).toEqual([problem])
    })
  })

  it("throws for an ownDirs folder that holds another workspace", () => {
    const files = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'packages/a/tools/*'\n",
      "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
      "packages/a/src/index.ts": "",
      "packages/a/tools/gen/package.json": JSON.stringify({ name: "@x/gen" }),
      "packages/a/tools/gen/src/index.ts": "",
    }
    scratchRoot(files, (root) => {
      const input: ArchitectureInput = {
        rootDir: root,
        workspaces: {
          "@x/a": { dir: "packages/a", type: "lib", ownDirs: ["tools"] },
          "@x/gen": { dir: "packages/a/tools/gen", type: "lib" },
        },
      }
      expect(problemsOf(input)).toEqual(['@x/a: ownDirs entry "tools" holds the workspace packages/a/tools/gen'])
    })
  })

  it("expands allowRootFiles globs to sorted literal files, skipping dotfiles and node_modules", () => {
    const files = {
      ...ONE_WORKSPACE,
      "eslint.config.mjs": "",
      "tooling/a.config.mjs": "",
      "tooling/deep/b.config.mjs": "",
      "tooling/.hidden.config.mjs": "",
      ".dot/c.config.mjs": "",
      "node_modules/x/d.config.mjs": "",
    }
    scratchRoot(files, (root) => {
      const { testPolicy } = defineArchitecture(
        policyOf(root, {}, { allowRootFiles: ["tooling/**/*.config.mjs", "eslint.config.mjs", "./eslint.config.mjs"] }),
      )
      expect(testPolicy.allowRootFiles).toEqual([
        "eslint.config.mjs",
        "tooling/a.config.mjs",
        "tooling/deep/b.config.mjs",
      ])
    })
  })

  // picomatch, the boundary plugin's matcher, reads a(b).mjs as a group that also matches ab.mjs.
  it.each([
    [
      "a literal entry with a group",
      { "tool(s).mjs": "" },
      "tool(s).mjs",
      'testPolicy.allowRootFiles entry "tool(s).mjs" uses an unsupported character; only the globs *, ** and ? are supported',
    ],
    [
      "a glob that expands to a name with a class",
      { "conf/[id].mjs": "" },
      "conf/?id?.mjs",
      'testPolicy.allowRootFiles entry "conf/?id?.mjs" matches conf/[id].mjs, whose name has one of * ? [ ] { } ( ) ! \\, so it can\'t be listed',
    ],
  ])("throws for %s", (_label, extra, entry, problem) => {
    scratchRoot({ ...ONE_WORKSPACE, ...extra }, (root) => {
      expect(problemsOf(policyOf(root, {}, { allowRootFiles: [entry] }))).toEqual([problem])
    })
  })

  it("throws for a workspace folder whose name the plugin would read as a pattern", () => {
    const files = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/(a)/package.json": JSON.stringify({ name: "@x/a" }),
      "packages/(a)/src/index.ts": "",
    }
    scratchRoot(files, (root) => {
      expect(problemsOf({ rootDir: root, workspaces: { "@x/a": { dir: "packages/(a)", type: "lib" } } })).toEqual([
        '@x/a: dir "packages/(a)" has one of * ? [ ] { } ( ) ! \\, which the boundary plugin reads as a pattern',
      ])
    })
  })

  it("throws for a workspace folder inside another workspace's src", () => {
    const files = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'packages/a/src/*'\n",
      "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
      "packages/a/src/index.ts": "",
      "packages/a/src/sub/package.json": JSON.stringify({ name: "@x/sub" }),
      "packages/a/src/sub/src/index.ts": "",
    }
    scratchRoot(files, (root) => {
      const input: ArchitectureInput = {
        rootDir: root,
        workspaces: {
          "@x/a": { dir: "packages/a", type: "lib" },
          "@x/sub": { dir: "packages/a/src/sub", type: "lib" },
        },
      }
      expect(problemsOf(input)).toEqual([
        "packages/a/src/sub is a workspace inside packages/a's src, so the boundary rules would read it as packages/a's own code",
      ])
    })
  })

  it("throws for an ownDirs folder that is a symlink", () => {
    scratchRoot({ ...ONE_WORKSPACE, "packages/a/data/x.json": "{}" }, (root) => {
      symlinkSync(join(root, "packages", "a", "data"), join(root, "packages", "a", "link"), "dir")
      expect(problemsOf(policyOf(root, { ownDirs: ["link"] }))).toEqual([
        '@x/a: ownDirs entry "link" must name the folder as it is on disk; it resolves to packages/a/data',
      ])
    })
  })

  it("throws for an allowRootFiles file that is a symlink", () => {
    scratchRoot({ ...ONE_WORKSPACE, "real.mjs": "" }, (root) => {
      symlinkSync(join(root, "real.mjs"), join(root, "link.mjs"))
      expect(problemsOf(policyOf(root, {}, { allowRootFiles: ["link.mjs"] }))).toEqual([
        'testPolicy.allowRootFiles entry "link.mjs" must name the file as it is on disk; it resolves to real.mjs',
      ])
    })
  })

  // Only a case-insensitive filesystem (macOS, Windows) can open "Test" as test; CI runs on Linux.
  it.skipIf(!caseInsensitive)("throws for an ownDirs entry that is the test folder in another case", () => {
    scratchRoot({ ...ONE_WORKSPACE, "packages/a/data/x.json": "{}", "packages/a/test/x.ts": "" }, (root) => {
      expect(problemsOf(policyOf(root, { ownDirs: ["Test"] }))).toEqual([
        '@x/a: ownDirs entry "Test" is inside test, which the boundary rules already check',
      ])
      expect(problemsOf(policyOf(root, { ownDirs: ["Data"] }))).toEqual([
        '@x/a: ownDirs entry "Data" must name the folder as it is on disk; it resolves to packages/a/data',
      ])
    })
  })

  it("throws for an ownDirs folder with its own package.json", () => {
    scratchRoot({ ...ONE_WORKSPACE, "packages/a/data/meta/package.json": '{"type":"module"}' }, (root) => {
      expect(problemsOf(policyOf(root, { ownDirs: ["data"] }))).toEqual([
        '@x/a: ownDirs entry "data" holds packages/a/data/meta/package.json, so its imports would be checked against that file, not @x/a\'s',
      ])
    })
  })

  it("checks ownDirs only once the workspace folder itself is valid", () => {
    scratchRoot(ONE_WORKSPACE, (root) => {
      const input: ArchitectureInput = {
        rootDir: root,
        workspaces: { "@x/a": { dir: "packages/nope", type: "lib", ownDirs: ["data"] } },
      }
      expect(problemsOf(input)).toEqual([
        '@x/a: dir "packages/nope" is not a workspace the root\'s pnpm-workspace.yaml lists',
        "packages/a is a workspace (@x/a) with no policy",
      ])
    })
  })

  it("takes a dotfile when it is listed exactly", () => {
    scratchRoot({ ...ONE_WORKSPACE, ".prettierrc.mjs": "" }, (root) => {
      expect(
        defineArchitecture(policyOf(root, {}, { allowRootFiles: [".prettierrc.mjs"] })).testPolicy.allowRootFiles,
      ).toEqual([".prettierrc.mjs"])
    })
  })

  it.each([
    ["matches no file", "missing.config.mjs", 'testPolicy.allowRootFiles entry "missing.config.mjs" matches no file'],
    ["is a glob that matches no file", "tools/*.mjs", 'testPolicy.allowRootFiles entry "tools/*.mjs" matches no file'],
    [
      "names a file inside a workspace",
      "packages/a/src/index.ts",
      'testPolicy.allowRootFiles entry "packages/a/src/index.ts" matches packages/a/src/index.ts (inside the workspace packages/a). A workspace\'s own folders go in its ownDirs, and other workspaces import it as a package',
    ],
    [
      "is a glob reaching into a workspace",
      "packages/**/*.ts",
      'testPolicy.allowRootFiles entry "packages/**/*.ts" matches packages/a/src/index.ts (inside the workspace packages/a). A workspace\'s own folders go in its ownDirs, and other workspaces import it as a package',
    ],
    [
      "escapes rootDir",
      "../outside.mjs",
      'testPolicy.allowRootFiles entry "../outside.mjs" must be a path inside rootDir, relative to it',
    ],
    [
      "is absolute",
      "/etc/hosts",
      'testPolicy.allowRootFiles entry "/etc/hosts" must be a path inside rootDir, relative to it',
    ],
    [
      "uses a brace glob",
      "{a,b}.mjs",
      'testPolicy.allowRootFiles entry "{a,b}.mjs" uses an unsupported character; only the globs *, ** and ? are supported',
    ],
    [
      "is under node_modules",
      "node_modules/x/y.js",
      'testPolicy.allowRootFiles entry "node_modules/x/y.js" is under node_modules',
    ],
  ])("throws for an allowRootFiles entry that %s", (_label, entry, problem) => {
    scratchRoot({ ...ONE_WORKSPACE, "node_modules/x/y.js": "" }, (root) => {
      expect(problemsOf(policyOf(root, {}, { allowRootFiles: [entry] }))).toEqual([problem])
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
      "a config comment with a unicode escape in the rule name",
      String.raw`const a = 1
/* eslint "\u0062oundaries/dependencies": 0 */`,
      2,
    ],
    [
      "a config comment with an escaped slash in the rule name",
      String.raw`const a = 1
/* eslint "boundaries\/dependencies": 0 */`,
      2,
    ],
    [
      "a config comment with an escaped letter in the rule name",
      String.raw`const a = 1
/* eslint "boundaries/\dependencies": 0 */`,
      2,
    ],
    [
      "a config comment with a single-quoted escaped name",
      String.raw`const a = 1
/* eslint '\u0062oundaries/dependencies': 0 */`,
      2,
    ],
    [
      "a config comment with a double dash inside an option value",
      'const a = 1\n/* eslint no-restricted-globals: [0, "a--b"], boundaries/dependencies: 0 */',
      2,
    ],
    [
      "a disable directive with a double dash inside the rule list",
      "const a = 1\n/* eslint-disable no-console --,boundaries/dependencies */\nconst b = 2",
      1,
    ],
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

  it("still reads a reason after a spaced double dash as no rule list", () => {
    expect(lint("const a = 1\n/* eslint-disable -- legacy code */\nconst b = 2")).toEqual([
      { line: 1, messageId: "blanket" },
    ])
  })

  it.each([
    ["a source code without directive methods", {}],
    ["one with only getDisableDirectives", { getDisableDirectives: () => ({ directives: [] }) }],
    ["no source code at all", null],
  ])("throws a clear error for %s", (_label, sourceCode) => {
    expect(() => asDirectiveSource(sourceCode)).toThrow("needs ESLint's JavaScript language")
  })

  it("leaves a disable of an unrelated rule alone", () => {
    expect(lint("// eslint-disable-next-line no-console\nconsole.log(1)")).toEqual([])
  })
})
