import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { defineArchitecture } from "../src/architecture"
import {
  createDepcruise,
  denyPathPattern,
  displayPath,
  formatViolations,
  OWN_DIRS_RULE,
  runDepcruise,
  transpilerProblem,
  UNRESOLVED_RULE,
} from "../src/depcruise"
import { depcruiseFixture, describeDepcruise, EXPECTED_DEPCRUISE } from "./architecture-expected"

/**
 * dependency-cruiser runs on the same on-disk pnpm fixture as the ESLint half, through the
 * built package (`ts-builds/depcruise` resolves to dist/), so this spec runs after the
 * build. Each fixture run is a child process with a real working directory.
 */
const repo = process.cwd()
const fixture = join(repo, "test", "fixtures", "architecture")
const cli = join(repo, "dist", "cli.js")

function runCli(cwd: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, "depcruise", ...args], { cwd, encoding: "utf-8" })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("depcruise on the pnpm fixture", () => {
  it("reports exactly the seeded violations, transitive ones included", () => {
    const run = depcruiseFixture(fixture, ".")
    expect(run.exitCode).toBe(1)
    expect(run.violations.map(describeDepcruise)).toEqual(EXPECTED_DEPCRUISE)
  }, 60_000)

  it.each(["packages/rules", "packages/rules/src", "apps/api"])(
    "reports the same violations when run from %s",
    (cwd) => {
      expect(depcruiseFixture(fixture, cwd).violations.map(describeDepcruise)).toEqual(EXPECTED_DEPCRUISE)
    },
    60_000,
  )

  it("finds the architecture file from a workspace directory and exits 1", () => {
    const run = runCli(join(fixture, "packages", "rules"))
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`✘ ${EXPECTED_DEPCRUISE.length} dependency violations`)
    expect(run.stdout).toContain("via packages/types/src/runtime.ts")
  }, 60_000)

  it("takes an explicit architecture file", () => {
    const run = runCli(tmpdir(), [join(fixture, "architecture.mjs")])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`✘ ${EXPECTED_DEPCRUISE.length} dependency violations`)
  }, 60_000)
})

describe("depcruise CLI without an architecture", () => {
  it("exits 2 when no architecture file is found", () => {
    const empty = mkdtempSync(join(tmpdir(), "ts-builds-depcruise-"))
    try {
      const run = runCli(empty)
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("No architecture.mjs, architecture.js, architecture.ts found")
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("prints usage for --help and exits 0", () => {
    const run = runCli(tmpdir(), ["--help"])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("Usage: ts-builds depcruise [file]")
  })

  it("exits 2 for a file argument that doesn't exist", () => {
    const run = runCli(tmpdir(), ["no-such-architecture.mjs"])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain("is not a file")
  })

  it("exits 2, not 1, when the policy throws while loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds-depcruise-"))
    try {
      writeFileSync(join(dir, "architecture.mjs"), 'throw new Error("Invalid architecture: rootDir")\n')
      const run = runCli(dir)
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("Invalid architecture: rootDir")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips a directory named architecture.mjs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds-depcruise-"))
    try {
      mkdirSync(join(dir, "architecture.mjs"))
      const run = runCli(dir)
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("found here or above")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ["a rootDir that isn't a string", "export default { rootDir: 1 }\n"],
    ["null workspaces", 'export default { rootDir: "x", workspaces: null, testPolicy: null }\n'],
  ])("exits 2 when the file exports %s", (_label, source) => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds-depcruise-"))
    try {
      writeFileSync(join(dir, "architecture.mjs"), source)
      const run = runCli(dir)
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("must default-export defineArchitecture(...)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("exits 2 when the file doesn't export a defined architecture", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-builds-depcruise-"))
    try {
      writeFileSync(join(dir, "architecture.mjs"), "export default { rootDir: 1 }\n")
      const run = runCli(dir)
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("must default-export defineArchitecture(...)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** A scratch pnpm workspace with source files only: nothing external to resolve. */
function scratchWorkspace(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ts-builds-depcruise-"))
  Object.entries(files).forEach(([path, contents]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  })
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

const pkg = (name: string): string => JSON.stringify({ name, version: "0.0.0", type: "module" })

describe("runDepcruise guards", () => {
  it(
    "fails, rather than passes, when a rule matches no cruised file",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": pkg("@x/a"),
          "packages/a/src/README.md": "no source files here\n",
          "packages/b/package.json": pkg("@x/b"),
          "packages/b/src/index.ts": "export const b = 1\n",
        },
        async (root) => {
          const architecture = defineArchitecture({
            rootDir: root,
            workspaces: {
              "@x/a": { dir: "packages/a", type: "pure", deny: ["pg"] },
              "@x/b": { dir: "packages/b", type: "lib" },
            },
          })
          const report = await runDepcruise(architecture)
          expect(report.exitCode).toBe(2)
          expect(report.output).toContain("deny-reachable:@x/a")
        },
      ),
    60_000,
  )

  it(
    "passes a clean workspace with exit code 0",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": pkg("@x/a"),
          "packages/a/src/index.ts": 'import { b } from "./b.ts"\nexport const a = b\n',
          "packages/a/src/b.ts": "export const b = 1\n",
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({
              rootDir: root,
              workspaces: { "@x/a": { dir: "packages/a", type: "pure", deny: ["pg"] } },
            }),
          )
          expect(report).toEqual({
            exitCode: 0,
            output: expect.stringContaining("✔ no dependency violations"),
            violations: [],
          })
        },
      ),
    60_000,
  )

  it.each([
    ["an unresolved alias", 'import { x } from "@/missing.ts"\nexport const a = x\n', "@/missing.ts"],
    ["an unresolved subpath import", 'import { x } from "#missing"\nexport const a = x\n', "#missing"],
    ["an unresolved relative import", 'import { x } from "../lib/x.ts"\nexport const a = x\n', "../lib/x.ts"],
    ["an unresolved home alias", 'import { x } from "~/x.ts"\nexport const a = x\n', "~/x.ts"],
    ["an unresolved absolute import", 'import { x } from "/nowhere/x.ts"\nexport const a = x\n', "/nowhere/x.ts"],
    // ESLint's resolver can resolve such an alias into an allowed workspace when dependency-cruiser
    // can't, so leaving it to ESLint would let a reach through it pass both halves.
    [
      "an alias that looks like a package name",
      'import { x } from "@lib/types/runtime"\nexport const a = x\n',
      "@lib/types/runtime",
    ],
    ["an undeclared package", 'import { x } from "undeclared-pkg"\nexport const a = x\n', "undeclared-pkg"],
  ])(
    "fails %s",
    (_label, source, to) =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": pkg("@x/a"),
          "packages/a/src/index.ts": source,
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({ rootDir: root, workspaces: { "@x/a": { dir: "packages/a", type: "lib" } } }),
          )
          expect(report.exitCode).toBe(1)
          expect(report.violations).toEqual([
            { rule: `${UNRESOLVED_RULE}:@x/a`, from: "packages/a/src/index.ts", to, via: [] },
          ])
        },
      ),
    60_000,
  )

  it(
    "leaves an unresolved package the workspace declares through @types alone",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": JSON.stringify({
            name: "@x/a",
            version: "0.0.0",
            type: "module",
            devDependencies: { "@types/types-only-package": "1.0.0", "@types/scope__typed": "1.0.0" },
          }),
          "packages/a/src/index.ts":
            'import type { T } from "types-only-package"\nimport type { U } from "@scope/typed/sub"\nexport type A = T | U\n',
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({ rootDir: root, workspaces: { "@x/a": { dir: "packages/a", type: "lib" } } }),
          )
          expect(report.exitCode).toBe(0)
        },
      ),
    60_000,
  )
})

// tmpdir() on macOS is under the /var symlink, so this also proves a symlinked root works.
describe("workspace exports with a types condition first", () => {
  it(
    "follows the code, not the declaration file, so a reach through it is reported",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": JSON.stringify({
            name: "@x/a",
            version: "0.0.0",
            type: "module",
            dependencies: { "@x/b": "workspace:*" },
          }),
          "packages/a/src/index.ts": 'import { b } from "@x/b"\nexport const a = b\n',
          "packages/b/package.json": JSON.stringify({
            name: "@x/b",
            version: "0.0.0",
            type: "module",
            exports: { ".": { types: "./src/types.d.ts", import: "./src/index.ts" } },
          }),
          "packages/b/src/index.ts": 'import { readFileSync } from "node:fs"\nexport const b = readFileSync\n',
          "packages/b/src/types.d.ts": "export declare const b: unknown\n",
        },
        async (root) => {
          // What `pnpm install` would link: the workspace dependency as a symlink.
          mkdirSync(join(root, "packages", "a", "node_modules", "@x"), { recursive: true })
          symlinkSync(join(root, "packages", "b"), join(root, "packages", "a", "node_modules", "@x", "b"), "dir")
          const report = await runDepcruise(
            defineArchitecture({
              rootDir: root,
              workspaces: {
                "@x/a": { dir: "packages/a", type: "pure", deny: ["fs"] },
                "@x/b": { dir: "packages/b", type: "lib" },
              },
            }),
          )
          expect(report.violations).toEqual([
            {
              rule: "deny-reachable:@x/a",
              from: "packages/a/src/index.ts",
              to: "fs",
              via: ["packages/b/src/index.ts"],
            },
          ])
        },
      ),
    60_000,
  )
})

describe("ownDirs", () => {
  it(
    "reports ownDirs code importing an enclosing workspace, but not its own folder inside it",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/outer'\n  - 'packages/outer/inner'\n",
          "packages/outer/package.json": pkg("@x/outer"),
          "packages/outer/src/index.ts": "export const outer = 1\n",
          "packages/outer/inner/package.json": pkg("@x/inner"),
          "packages/outer/inner/src/index.ts":
            'import { own } from "../data/own.ts"\nimport { up } from "../data/up.ts"\nexport const inner = [own, up]\n',
          // Its own src: packages/outer/inner sits inside the disallowed packages/outer.
          "packages/outer/inner/data/own.ts":
            'import { inner } from "../src/index.ts"\nexport const own = () => inner\n',
          "packages/outer/inner/data/up.ts": 'import { outer } from "../../src/index.ts"\nexport const up = outer\n',
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({
              rootDir: root,
              workspaces: {
                "@x/outer": { dir: "packages/outer", type: "lib" },
                "@x/inner": { dir: "packages/outer/inner", type: "lib", ownDirs: ["data"] },
              },
            }),
          )
          expect(report.violations.filter((violation) => violation.rule.startsWith(OWN_DIRS_RULE))).toEqual([
            {
              rule: `${OWN_DIRS_RULE}-boundary:@x/inner`,
              from: "packages/outer/inner/data/up.ts",
              to: "packages/outer/src/index.ts",
              via: [],
            },
          ])
        },
      ),
    60_000,
  )

  // Workspace folders nest, so a disallowed workspace can sit inside this one or inside an allowed one.
  it.each([
    [
      "a disallowed workspace inside this one",
      "packages/outer",
      {
        "@x/outer": { dir: "packages/outer", type: "lib", ownDirs: ["data"] },
        "@x/inner": { dir: "packages/outer/inner", type: "lib" },
      },
      "packages/outer/data/d.ts",
      'import { inner } from "../inner/src/index.ts"\nexport const d = inner\n',
      "packages/outer/inner/src/index.ts",
    ],
    [
      "a disallowed workspace inside an allowed one",
      "packages/outer",
      {
        "@x/outer": { dir: "packages/outer", type: "lib", ownDirs: ["data"], allow: ["@x/ok"] },
        "@x/ok": { dir: "packages/ok", type: "lib" },
        "@x/bad": { dir: "packages/ok/bad", type: "lib" },
      },
      "packages/outer/data/d.ts",
      'import { bad } from "../../ok/bad/src/index.ts"\nexport const d = bad\n',
      "packages/ok/bad/src/index.ts",
    ],
  ] as const)(
    "reports ownDirs code importing %s",
    (_label, _dir, workspaces, file, source, to) =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'packages/*/*'\n",
          "packages/outer/package.json": pkg("@x/outer"),
          "packages/outer/src/index.ts": 'import { d } from "../data/d.ts"\nexport const outer = d\n',
          "packages/outer/inner/package.json": pkg("@x/inner"),
          "packages/outer/inner/src/index.ts": "export const inner = 1\n",
          "packages/ok/package.json": pkg("@x/ok"),
          "packages/ok/src/index.ts": "export const ok = 1\n",
          "packages/ok/bad/package.json": pkg("@x/bad"),
          "packages/ok/bad/src/index.ts": "export const bad = 1\n",
          [file]: source,
        },
        async (root) => {
          // Classify every listed workspace: the unused ones get a plain policy.
          const all = {
            "@x/outer": { dir: "packages/outer", type: "lib" },
            "@x/inner": { dir: "packages/outer/inner", type: "lib" },
            "@x/ok": { dir: "packages/ok", type: "lib" },
            "@x/bad": { dir: "packages/ok/bad", type: "lib" },
            ...workspaces,
          }
          const report = await runDepcruise(defineArchitecture({ rootDir: root, workspaces: all }))
          expect(report.violations.filter((violation) => violation.rule.startsWith(OWN_DIRS_RULE))).toEqual([
            { rule: `${OWN_DIRS_RULE}-boundary:@x/outer`, from: file, to, via: [] },
          ])
        },
      ),
    60_000,
  )

  it(
    "reports an installed copy of a workspace outside allow, as pnpm's injected dependencies leave it",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": JSON.stringify({
            name: "@x/a",
            version: "0.0.0",
            type: "module",
            dependencies: { "@x/b": "workspace:*" },
          }),
          "packages/a/src/index.ts": 'import { d } from "../data/d.ts"\nexport const a = d\n',
          "packages/a/data/d.ts": 'import { b } from "@x/b"\nexport const d = b\n',
          "packages/b/package.json": pkg("@x/b"),
          "packages/b/src/index.ts": "export const b = 1\n",
          // A copy, not a symlink: it resolves inside node_modules, so only the name gives it away.
          "packages/a/node_modules/@x/b/package.json": JSON.stringify({
            name: "@x/b",
            version: "0.0.0",
            type: "module",
            exports: "./src/index.ts",
          }),
          "packages/a/node_modules/@x/b/src/index.ts": "export const b = 1\n",
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({
              rootDir: root,
              workspaces: {
                "@x/a": { dir: "packages/a", type: "lib", ownDirs: ["data"] },
                "@x/b": { dir: "packages/b", type: "lib" },
              },
            }),
          )
          expect(report.violations.filter((violation) => violation.rule.startsWith(OWN_DIRS_RULE))).toEqual([
            {
              rule: `${OWN_DIRS_RULE}-workspace-package:@x/a`,
              from: "packages/a/data/d.ts",
              to: "packages/a/node_modules/@x/b/src/index.ts",
              via: [],
            },
          ])
        },
      ),
    60_000,
  )

  it(
    "reports ownDirs code importing a .spec. file in its own src",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": pkg("@x/a"),
          "packages/a/src/index.ts": 'import { d } from "../data/d.ts"\nexport const a = d\n',
          "packages/a/src/a.spec.ts": "export const s = 1\n",
          "packages/a/data/d.ts": 'import { s } from "../src/a.spec.ts"\nexport const d = s\n',
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({
              rootDir: root,
              workspaces: { "@x/a": { dir: "packages/a", type: "lib", ownDirs: ["data"] } },
            }),
          )
          expect(report.violations).toEqual([
            {
              rule: `${OWN_DIRS_RULE}-test-file:@x/a`,
              from: "packages/a/data/d.ts",
              to: "packages/a/src/a.spec.ts",
              via: [],
            },
          ])
        },
      ),
    60_000,
  )

  it(
    "passes an ownDirs folder that nothing imports, rather than failing the zero-match guard",
    () =>
      scratchWorkspace(
        {
          "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
          "packages/a/package.json": pkg("@x/a"),
          "packages/a/src/index.ts": "export const a = 1\n",
          "packages/a/migrations/0001.sql": "create table t (id int);\n",
        },
        async (root) => {
          const report = await runDepcruise(
            defineArchitecture({
              rootDir: root,
              workspaces: { "@x/a": { dir: "packages/a", type: "lib", ownDirs: ["migrations"] } },
            }),
          )
          expect(report).toEqual({
            exitCode: 0,
            output: expect.stringContaining("✔ no dependency violations"),
            violations: [],
          })
        },
      ),
    60_000,
  )
})

describe("createDepcruise", () => {
  it("roots every path at rootDir and cruises src and test, never the working directory", () =>
    scratchWorkspace(
      {
        "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
        "packages/a/package.json": pkg("@x/a"),
        "packages/a/src/index.ts": "export const a = 1\n",
        "packages/a/test/a.test.ts": "export const t = 1\n",
        "packages/a/tsconfig.json": "{}\n",
        "packages/b/package.json": pkg("@x/b"),
        "packages/b/src/index.ts": "export const b = 1\n",
      },
      async (root) => {
        const config = createDepcruise(
          defineArchitecture({
            rootDir: root,
            workspaces: {
              "@x/a": { dir: "packages/a", type: "pure", deny: ["pg"] },
              "@x/b": { dir: "packages/b", type: "lib" },
            },
          }),
        )
        expect(config.entries).toEqual(["packages/a/src", "packages/a/test", "packages/b/src"])
        expect(config.options).toMatchObject({
          baseDir: realpathSync(root),
          enhancedResolveOptions: {
            tsconfig: {
              configFile: join(realpathSync(root), "packages", "a", "tsconfig.json"),
              references: [join(realpathSync(root), "packages", "a")],
            },
          },
        })
        expect(config.forbidden.map((rule) => rule.name)).toEqual([
          "deny-reachable:@x/a",
          "no-circular",
          `${UNRESOLVED_RULE}:@x/a`,
          `${UNRESOLVED_RULE}:@x/b`,
        ])
      },
    ))
})

describe("denyPathPattern", () => {
  const matches = (deny: string[], path: string): boolean => new RegExp(denyPathPattern(deny)).test(path)

  it.each([
    [["pg"], "node_modules/.pnpm/pg@8.16.3/node_modules/pg/esm/index.mjs", true],
    [["pg"], "node_modules/pg/lib/utils.js", true],
    [["pg"], "node_modules/.pnpm/pg-pool@3.0.0/node_modules/pg-pool/index.js", false],
    [["@ai-sdk/*"], "node_modules/.pnpm/@ai-sdk+openai@1.0.0/node_modules/@ai-sdk/openai/index.js", true],
    [["@ai-sdk/*"], "node_modules/@ai-sdk-other/x/index.js", false],
    [["fs"], "fs", true],
    [["fs"], "fs/promises", true],
    [["node:fs"], "fs", true],
    [["node:o*"], "os", true],
    [["fs"], "packages/fs/src/index.ts", false],
    [["a.b"], "node_modules/aXb/index.js", false],
  ])("%j against %s is %s", (deny, path, expected) => {
    expect(matches(deny, path)).toBe(expected)
  })
})

describe("formatViolations", () => {
  it("shortens package paths and names the modules in between", () => {
    expect(
      formatViolations(
        [
          {
            rule: "deny-reachable:@x/a",
            from: "packages/a/src/index.ts",
            to: "node_modules/.pnpm/pg@1.0.0/node_modules/pg/index.js",
            via: ["packages/b/src/db.ts"],
          },
        ],
        12,
      ),
    ).toBe(
      "  error deny-reachable:@x/a: packages/a/src/index.ts → pg/index.js\n      via packages/b/src/db.ts\n" +
        "✘ 1 dependency violation (12 modules cruised)",
    )
    expect(displayPath("fs")).toBe("fs")
  })
})

describe("transpilerProblem", () => {
  it("is none when TypeScript is available", () => {
    expect(
      transpilerProblem([
        { name: "javascript", available: true },
        { name: "typescript", available: true },
      ]).isNone(),
    ).toBe(true)
  })

  it.each([
    ["missing", [{ name: "javascript", available: true }]],
    ["unavailable", [{ name: "typescript", available: false }]],
  ])("names the fix when TypeScript is %s", (_label, transpilers) => {
    expect(transpilerProblem(transpilers).orElse("")).toContain("Install typescript")
  })
})
