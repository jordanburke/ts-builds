import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { cleanDir, pruneOrphans, snapshotMtimes } from "../../src/cli/commands/build"

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
      expect(snap.has(join(dist, "index.js"))).toBe(true)
      expect(snap.has(join(dist, "rules", "x.js"))).toBe(true)
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
      await pruneOrphans(dist, new Map())
      expect(existsSync(join(dist, "index.js"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
