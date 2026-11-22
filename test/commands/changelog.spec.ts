import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync, spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

import { parseConventionalCommit, extractIssueRefs } from "../../src/cli/commands/changelog"

describe("ts-builds changelog", () => {
  describe("parseConventionalCommit", () => {
    it("should parse basic conventional commit", () => {
      const result = parseConventionalCommit("feat: add new feature").orThrow()
      expect(result.type).toBe("feat")
      expect(result.scope.isNone()).toBe(true)
      expect(result.breaking).toBe(false)
      expect(result.description).toBe("add new feature")
    })

    it("should parse scoped commit", () => {
      const result = parseConventionalCommit("fix(cli): resolve path issue").orThrow()
      expect(result.type).toBe("fix")
      expect(result.scope.isSome()).toBe(true)
      expect(result.scope.getOrElse(() => "")).toBe("cli")
      expect(result.breaking).toBe(false)
      expect(result.description).toBe("resolve path issue")
    })

    it("should parse breaking change indicator", () => {
      const result = parseConventionalCommit("feat!: remove deprecated API").orThrow()
      expect(result.type).toBe("feat")
      expect(result.scope.isNone()).toBe(true)
      expect(result.breaking).toBe(true)
      expect(result.description).toBe("remove deprecated API")
    })

    it("should parse scoped breaking change", () => {
      const result = parseConventionalCommit("refactor(config)!: change config format").orThrow()
      expect(result.type).toBe("refactor")
      expect(result.scope.getOrElse(() => "")).toBe("config")
      expect(result.breaking).toBe(true)
      expect(result.description).toBe("change config format")
    })

    it("should return null for non-conventional commits", () => {
      expect(parseConventionalCommit("just a message").isNone()).toBe(true)
      expect(parseConventionalCommit("bump").isNone()).toBe(true)
      expect(parseConventionalCommit("2.6.1").isNone()).toBe(true)
    })
  })

  describe("extractIssueRefs", () => {
    it("should extract issue numbers", () => {
      const result = extractIssueRefs("fix: resolve #123 and #456")
      expect(result.toArray()).toEqual(["123", "456"])
    })

    it("should return empty list when no issues", () => {
      const result = extractIssueRefs("feat: add feature")
      expect(result.isEmpty).toBe(true)
    })

    it("should handle PR references in commit body", () => {
      const result = extractIssueRefs("Closes #42\nRelated to #99")
      expect(result.toArray()).toEqual(["42", "99"])
    })
  })

  describe("CLI integration", () => {
    const cliPath = join(process.cwd(), "dist/cli.js")

    it("should run changelog command", () => {
      const output = execSync(`node ${cliPath} changelog`, { encoding: "utf-8" })
      expect(output.length).toBeGreaterThan(0)
    })

    // A repo of its own with one conventional commit: the checkout's history (CI clones a single
    // merge commit) would otherwise end the run at "No conventional commits found", before the write.
    const inRepo = (run: (dir: string) => void): void => {
      const dir = mkdtempSync(join(tmpdir(), "ts-builds-changelog-"))
      try {
        const git = (...args: string[]) =>
          execSync(`git -c user.name=test -c user.email=test@example.com ${args.join(" ")}`, { cwd: dir })
        git("init", "-q")
        git("commit", "-q", "--allow-empty", "-m", '"feat: add a thing"')
        run(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it("--output writes the changelog and exits 0", () => {
      inRepo((dir) => {
        const res = spawnSync(process.execPath, [cliPath, "changelog", "--output", "CHANGELOG.md"], {
          cwd: dir,
          encoding: "utf-8",
        })
        expect(res.status).toBe(0)
        expect(res.stdout).toContain("Changelog written to CHANGELOG.md")
      })
    })

    it("exits 1 with the reason when --output can't be written", () => {
      inRepo((dir) => {
        const res = spawnSync(process.execPath, [cliPath, "changelog", "--output", "no-such-dir/CHANGELOG.md"], {
          cwd: dir,
          encoding: "utf-8",
        })
        expect(res.status).toBe(1)
        expect(res.stderr).toContain("Couldn't write the changelog to no-such-dir/CHANGELOG.md")
        expect(res.stdout).not.toContain("Changelog written")
      })
    })

    it("should accept --since flag", () => {
      const output = execSync(`node ${cliPath} changelog --since v2.5.2 --version 2.6.1`, {
        encoding: "utf-8",
      })
      expect(output.length).toBeGreaterThan(0)
    })
  })
})
