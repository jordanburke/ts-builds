import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { LintReport } from "../../src/cli/lint-report"

/**
 * These exercise `runLint`'s bundled Node-API path end to end — the highest-risk code,
 * unreachable by a plain unit test because `targetDir` is captured at module load. We
 * spawn the built CLI with `cwd` set to a throwaway package so ESLint lints the fixture
 * and writes the sidecar there. Skipped (not failed) when `dist/cli.js` is absent, e.g.
 * a bare `pnpm test` before `pnpm build`; CI runs `validate:bootstrap` (build → test).
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
const cliPath = join(repoRoot, "dist", "cli.js")
const itIfBuilt = it.skipIf(!existsSync(cliPath))

function makeFixture(config: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-builds-run-lint-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@fixture/pkg", type: "module" }))
  writeFileSync(join(dir, "eslint.config.js"), config)
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, contents)
  }
  return dir
}

function runCli(cwd: string, ...args: string[]): { status: number; stdout: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf-8" })
  return { status: res.status ?? -1, stdout: res.stdout ?? "" }
}

function readReport(dir: string): LintReport {
  return JSON.parse(readFileSync(join(dir, ".ts-builds", "lint-report.json"), "utf-8")) as LintReport
}

describe("runLint (bundled Node API, via built CLI)", () => {
  itIfBuilt("errors → exit 1, stylish output printed, sidecar errorCount>0", () => {
    const dir = makeFixture('export default [{ rules: { "no-unused-vars": "error" } }]', {
      "src/a.js": "const unused = 1\nexport default 2\n",
    })
    try {
      const { status, stdout } = runCli(dir, "lint:check")
      expect(status).toBe(1)
      expect(stdout).toContain("no-unused-vars") // proves writeAll flushed the report
      const report = readReport(dir)
      expect(report.errorCount).toBeGreaterThan(0)
      expect(report.fix).toBe(false)
      expect(report.fatal).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itIfBuilt("no matching files (thrown) → exit 2, fatal sidecar", () => {
    const dir = makeFixture("export default []", {}) // no src/
    try {
      const { status } = runCli(dir, "lint:check")
      expect(status).toBe(2)
      expect(readReport(dir).fatal).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itIfBuilt("--fix writes fixes to disk, sidecar fix:true errorCount:0", () => {
    const dir = makeFixture('export default [{ rules: { semi: ["error", "never"] } }]', {
      "src/a.js": "export const x = 1;;\n",
    })
    try {
      const { status } = runCli(dir, "lint") // fix mode
      expect(status).toBe(0)
      expect(readFileSync(join(dir, "src", "a.js"), "utf-8")).not.toContain(";")
      const report = readReport(dir)
      expect(report.fix).toBe(true)
      expect(report.errorCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe("lint.includeTests", () => {
    const noUnused = 'export default [{ rules: { "no-unused-vars": "error" } }]'
    const dirty = "const unused = 1\nexport default 2\n"
    const config = (includeTests: boolean) => JSON.stringify({ lint: { includeTests } })

    const inFixture = (config: string, files: Record<string, string>, run: (dir: string) => void): void => {
      const dir = makeFixture(config, files)
      try {
        run(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    itIfBuilt("off: a broken test file isn't linted", () => {
      inFixture(
        noUnused,
        { "ts-builds.config.json": config(false), "src/a.js": "export default 1\n", "test/a.js": dirty },
        (dir) => {
          expect(runCli(dir, "lint:check").status).toBe(0)
        },
      )
    })

    itIfBuilt("on: lints both directories, and the sidecar counts both", () => {
      inFixture(noUnused, { "ts-builds.config.json": config(true), "src/a.js": dirty, "test/a.js": dirty }, (dir) => {
        const { status, stdout } = runCli(dir, "lint:check")
        expect(status).toBe(1)
        expect(stdout).toContain(join("src", "a.js"))
        expect(stdout).toContain(join("test", "a.js"))
        expect(readReport(dir).errorCount).toBe(2)
      })
    })

    itIfBuilt("on, with no testDir: lints srcDir and exits 0", () => {
      inFixture(noUnused, { "ts-builds.config.json": config(true), "src/a.js": "export default 1\n" }, (dir) => {
        expect(runCli(dir, "lint:check").status).toBe(0)
      })
    })

    itIfBuilt("on, with an absolute testDir: lints it", () => {
      inFixture(noUnused, { "src/a.js": "export default 1\n", "test/a.js": dirty }, (dir) => {
        writeFileSync(
          join(dir, "ts-builds.config.json"),
          JSON.stringify({ lint: { includeTests: true }, testDir: join(dir, "test") }),
        )
        expect(runCli(dir, "lint:check").status).toBe(1)
        expect(readReport(dir).errorCount).toBe(1)
      })
    })

    itIfBuilt("on, with test files outside the tsconfig: one message, and they count as errors", () => {
      const parser = join(repoRoot, "node_modules", "typescript-eslint", "dist", "index.js")
      const typeAware = `import tseslint from ${JSON.stringify(parser)}
export default [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } }]`
      inFixture(
        typeAware,
        {
          "ts-builds.config.json": config(true),
          "tsconfig.json": JSON.stringify({ include: ["src/**/*"] }),
          "src/a.ts": "export const a = 1\n",
          "test/a.ts": "export const b = 1\n",
          "test/b.ts": "export const c = 1\n",
        },
        (dir) => {
          const { status, stdout } = runCli(dir, "lint:check")
          expect(status).toBe(1)
          expect(stdout).toContain("2 file(s) in ./test aren't in a tsconfig")
          expect(stdout).toContain('Add "test/**/*" to "include"')
          expect(stdout).not.toContain("was not found by the project service")
          expect(readReport(dir).errorCount).toBe(2)
        },
      )
    })

    itIfBuilt("off, with testDir inside srcDir: keeps ESLint's own parse error", () => {
      const parser = join(repoRoot, "node_modules", "typescript-eslint", "dist", "index.js")
      const typeAware = `import tseslint from ${JSON.stringify(parser)}
export default [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } }]`
      inFixture(
        typeAware,
        {
          "ts-builds.config.json": JSON.stringify({ lint: { includeTests: false }, testDir: "./src/__tests__" }),
          "tsconfig.json": JSON.stringify({ include: ["src/*.ts"] }),
          "src/a.ts": "export const a = 1\n",
          "src/__tests__/a.ts": "export const b = 1\n",
        },
        (dir) => {
          const { status, stdout } = runCli(dir, "lint:check")
          expect(status).toBe(1)
          expect(stdout).toContain("was not found by the project service")
          expect(stdout).not.toContain("aren't in a tsconfig")
        },
      )
    })

    itIfBuilt("on, with a trailing slash on testDir: the hint reads cleanly", () => {
      const parser = join(repoRoot, "node_modules", "typescript-eslint", "dist", "index.js")
      const typeAware = `import tseslint from ${JSON.stringify(parser)}
export default [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } }]`
      inFixture(
        typeAware,
        {
          "ts-builds.config.json": JSON.stringify({ lint: { includeTests: true }, testDir: "./test/" }),
          "tsconfig.json": JSON.stringify({ include: ["src/**/*"] }),
          "src/a.ts": "export const a = 1\n",
          "test/a.ts": "export const b = 1\n",
        },
        (dir) => {
          expect(runCli(dir, "lint:check").stdout).toContain('Add "test/**/*" to "include"')
        },
      )
    })

    // The stub is a shell script, which npx can't run on Windows.
    it.skipIf(!existsSync(cliPath) || process.platform === "win32")(
      "on, with useProjectEslint: the project's eslint gets both directories",
      () => {
        const stub = '#!/bin/sh\necho "$@" > eslint-args.txt\n'
        inFixture(
          "export default []",
          {
            "ts-builds.config.json": JSON.stringify({ lint: { includeTests: true, useProjectEslint: true } }),
            "src/a.js": "",
            "test/a.js": "",
            "node_modules/.bin/eslint": stub,
          },
          (dir) => {
            chmodSync(join(dir, "node_modules", ".bin", "eslint"), 0o755)
            expect(runCli(dir, "lint:check").status).toBe(0)
            expect(readFileSync(join(dir, "eslint-args.txt"), "utf-8").trim()).toBe("./src ./test")
          },
        )
      },
    )
  })
})
