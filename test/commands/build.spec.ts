import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { cleanDir } from "../../src/cli/commands/build"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-clean-"))
}

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
