import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { Map, Option } from "functype"

import {
  cleanDir,
  consumerHasPrettierConfig,
  prettierFormatArgs,
  workspacePrettierIgnorePath,
  pruneOrphans,
  snapshotMtimes,
} from "../../src/cli/commands/build"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-clean-"))
}

const tick = (ms = 12): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("cleanDir", () => {
  it("removes a populated directory and returns 0", async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, "dist")
      await mkdir(join(target, "nested"), { recursive: true })
      writeFileSync(join(target, "a.txt"), "hello")
      writeFileSync(join(target, "nested", "b.txt"), "world")
      expect(existsSync(target)).toBe(true)

      const code = await cleanDir(target)
      expect(code).toBe(0)
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns 0 when the directory does not exist (force semantics)", async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, "never-existed")
      expect(existsSync(target)).toBe(false)
      const code = await cleanDir(target)
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handles deeply nested structures", async () => {
    const dir = makeTempDir()
    try {
      const target = join(dir, "dist")
      const deep = join(target, "a", "b", "c", "d", "e")
      await mkdir(deep, { recursive: true })
      writeFileSync(join(deep, "leaf.txt"), "x")
      const code = await cleanDir(target)
      expect(code).toBe(0)
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("snapshotMtimes", () => {
  it("returns an empty map when the directory does not exist", async () => {
    const dir = makeTempDir()
    try {
      const snap = await snapshotMtimes(join(dir, "never-existed"))
      expect(snap.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records every file recursively", async () => {
    const dir = makeTempDir()
    try {
      const dist = join(dir, "dist")
      await mkdir(join(dist, "rules"), { recursive: true })
      writeFileSync(join(dist, "index.js"), "a")
      writeFileSync(join(dist, "rules", "x.js"), "b")
      const snap = await snapshotMtimes(dist)
      expect(snap.size).toBe(2)
      expect(snap.get(join(dist, "index.js")).isSome()).toBe(true)
      expect(snap.get(join(dist, "rules", "x.js")).isSome()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("pruneOrphans", () => {
  it("removes files untouched since the snapshot, keeps rewritten and new files", async () => {
    const dir = makeTempDir()
    try {
      const dist = join(dir, "dist")
      await mkdir(dist, { recursive: true })
      writeFileSync(join(dist, "keep.js"), "old")
      writeFileSync(join(dist, "orphan.js"), "stale")

      const before = await snapshotMtimes(dist)

      // Simulate a --no-clean build: rewrite keep.js (newer mtime), add new.js,
      // leave orphan.js untouched (its source entry no longer exists).
      await tick()
      writeFileSync(join(dist, "keep.js"), "new")
      writeFileSync(join(dist, "new.js"), "fresh")

      await pruneOrphans(dist, before)

      expect(existsSync(join(dist, "keep.js"))).toBe(true)
      expect(existsSync(join(dist, "new.js"))).toBe(true)
      expect(existsSync(join(dist, "orphan.js"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("no-ops on an empty snapshot (fresh dist)", async () => {
    const dir = makeTempDir()
    try {
      const dist = join(dir, "dist")
      await mkdir(dist, { recursive: true })
      writeFileSync(join(dist, "index.js"), "a")
      await pruneOrphans(dist, Map.empty<string, number>())
      expect(existsSync(join(dist, "index.js"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("prettierFormatArgs", () => {
  const ignore = "/pkg/ts-builds/.prettierignore"
  const config = "/pkg/ts-builds/prettier-config.cjs"
  const noConfig = Option.none<string>()
  const noWorkspace = Option.none<string>()
  const workspace = "/repo/.prettierignore"

  it("check mode targets the whole tree", () => {
    expect(prettierFormatArgs(true, null, noConfig, noWorkspace)[0]).toBe("--check")
    expect(prettierFormatArgs(false, null, noConfig, noWorkspace)[0]).toBe("--write")
    expect(prettierFormatArgs(true, null, noConfig, noWorkspace)).toContain(".")
  })

  it("passes BOTH the bundled ignore and the consumer's ./.prettierignore (additive, quoted)", () => {
    // Explicit --ignore-path overrides prettier's default discovery, so the consumer's own
    // ./.prettierignore must be passed too or their entries would be silently dropped. The
    // bundled path is quoted so a spaced install path survives shell:true.
    expect(prettierFormatArgs(true, ignore, noConfig, noWorkspace)).toEqual([
      "--check",
      ".",
      "--ignore-path",
      `"${ignore}"`,
      "--ignore-path",
      ".prettierignore",
    ])
  })

  it("adds the workspace root's .prettierignore, quoted, before the consumer's own", () => {
    expect(prettierFormatArgs(true, ignore, noConfig, Option(workspace))).toEqual([
      "--check",
      ".",
      "--ignore-path",
      `"${ignore}"`,
      "--ignore-path",
      `"${workspace}"`,
      "--ignore-path",
      ".prettierignore",
    ])
  })

  it("still passes the consumer's ./.prettierignore when only the workspace ignore is found", () => {
    // Any explicit --ignore-path turns off prettier's own discovery of ./.prettierignore.
    expect(prettierFormatArgs(false, null, noConfig, Option(workspace))).toEqual([
      "--write",
      ".",
      "--ignore-path",
      `"${workspace}"`,
      "--ignore-path",
      ".prettierignore",
    ])
  })

  it("falls back to bare args when the bundled ignore can't be located", () => {
    expect(prettierFormatArgs(false, null, noConfig, noWorkspace)).toEqual(["--write", "."])
  })

  it("appends the quoted bundled --config when the consumer has none", () => {
    expect(prettierFormatArgs(false, null, Option(config), noWorkspace)).toEqual([
      "--write",
      ".",
      "--config",
      `"${config}"`,
    ])
  })

  it("omits --config entirely when the consumer has their own", () => {
    // An explicit --config disables prettier's discovery, so passing ours would silently override
    // a config the consumer deliberately wrote.
    expect(prettierFormatArgs(false, null, noConfig, noWorkspace)).not.toContain("--config")
  })
})

describe("consumerHasPrettierConfig", () => {
  it("finds a config file in the starting directory", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, ".prettierrc"), "{}")
      expect(consumerHasPrettierConfig(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("finds a package.json prettier key", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", prettier: "ts-builds/prettier" }))
      expect(consumerHasPrettierConfig(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inherits a config from an ancestor directory (monorepo package)", () => {
    // A workspace package with no local config still resolves the root's — overriding it with
    // --config would break the monorepo's shared style.
    const root = makeTempDir()
    try {
      const pkg = join(root, "packages", "app")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(root, ".prettierrc"), "{}")
      expect(consumerHasPrettierConfig(pkg)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("ignores a package.json with no prettier key", () => {
    // The walk runs to the real filesystem root, so a bare `toBe(false)` would depend on the
    // machine's /tmp ancestry. Compare against an empty sibling instead: adding a keyless
    // package.json must not change the verdict.
    const withPkg = makeTempDir()
    const control = makeTempDir()
    try {
      writeFileSync(join(withPkg, "package.json"), JSON.stringify({ name: "x" }))
      expect(consumerHasPrettierConfig(withPkg)).toBe(consumerHasPrettierConfig(control))
    } finally {
      rmSync(withPkg, { recursive: true, force: true })
      rmSync(control, { recursive: true, force: true })
    }
  })

  it("tolerates an unparseable package.json", () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, "package.json"), "{ not json")
      expect(() => consumerHasPrettierConfig(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("workspacePrettierIgnorePath", () => {
  function workspace(marker: "pnpm" | "npm", withIgnore = true): { root: string; pkg: string } {
    const root = makeTempDir()
    const pkg = join(root, "apps", "web")
    mkdirSync(pkg, { recursive: true })
    if (marker === "pnpm") writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n")
    else writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["apps/*"] }))
    if (withIgnore) writeFileSync(join(root, ".prettierignore"), "**/gen.ts\n")
    return { root, pkg }
  }

  it("finds the .prettierignore of an enclosing pnpm workspace", () => {
    const { root, pkg } = workspace("pnpm")
    try {
      expect(workspacePrettierIgnorePath(pkg).orNull()).toBe(join(root, ".prettierignore"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("finds the .prettierignore of an enclosing npm/yarn workspace", () => {
    const { root, pkg } = workspace("npm")
    try {
      expect(workspacePrettierIgnorePath(pkg).orNull()).toBe(join(root, ".prettierignore"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not return the root's own file when run at the root, which already passes ./.prettierignore", () => {
    const { root } = workspace("pnpm")
    try {
      expect(workspacePrettierIgnorePath(root).orNull()).not.toBe(join(root, ".prettierignore"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns nothing for the workspace when its root has no .prettierignore", () => {
    const { root, pkg } = workspace("pnpm", false)
    try {
      expect(workspacePrettierIgnorePath(pkg).orNull()).not.toBe(join(root, ".prettierignore"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("format:check inside a workspace package (end-to-end)", () => {
  const cliPath = join(process.cwd(), "dist/cli.js")

  function formatCheck(cwd: string): number {
    try {
      execFileSync("node", [cliPath, "format:check"], { cwd, stdio: "pipe" })
      return 0
    } catch (err) {
      return (err as { status?: number }).status ?? 1
    }
  }

  it("honours the workspace root's .prettierignore for a file prettier would reject", () => {
    const root = makeTempDir()
    try {
      const pkg = join(root, "apps", "web")
      mkdirSync(join(pkg, "src"), { recursive: true })
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n")
      // Prettier-clean, so the only file the check can object to is gen.ts.
      writeFileSync(join(pkg, "package.json"), '{\n  "name": "web"\n}\n')
      // Generated-style code prettier would reformat (single quotes, semicolons).
      writeFileSync(join(pkg, "src", "gen.ts"), "export const a = 'x';\n")
      // Control: no root ignore, so the check fails on gen.ts.
      expect(formatCheck(pkg)).not.toBe(0)
      writeFileSync(join(root, ".prettierignore"), "**/gen.ts\n")
      expect(formatCheck(pkg)).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
