import { join } from "node:path"
import { execSync } from "node:child_process"
import { describe, expect, it } from "vitest"

import { parseConventionalCommit, extractIssueRefs } from "../../src/cli/commands/changelog"

describe("ts-builds changelog", () => {
  describe("parseConventionalCommit", () => {
    it("should parse basic conventional commit", () => {
      const result = parseConventionalCommit("feat: add new feature")
      expect(result).not.toBeNull()
      expect(result!.type).toBe("feat")
      expect(result!.scope.isNone()).toBe(true)
      expect(result!.breaking).toBe(false)
      expect(result!.description).toBe("add new feature")
    })

    it("should parse scoped commit", () => {
      const result = parseConventionalCommit("fix(cli): resolve path issue")
      expect(result).not.toBeNull()
      expect(result!.type).toBe("fix")
      expect(result!.scope.isSome()).toBe(true)
      expect(result!.scope.orElse("")).toBe("cli")
      expect(result!.breaking).toBe(false)
      expect(result!.description).toBe("resolve path issue")
    })

    it("should parse breaking change indicator", () => {
      const result = parseConventionalCommit("feat!: remove deprecated API")
      expect(result).not.toBeNull()
      expect(result!.type).toBe("feat")
      expect(result!.scope.isNone()).toBe(true)
      expect(result!.breaking).toBe(true)
      expect(result!.description).toBe("remove deprecated API")
    })

    it("should parse scoped breaking change", () => {
      const result = parseConventionalCommit("refactor(config)!: change config format")
      expect(result).not.toBeNull()
      expect(result!.type).toBe("refactor")
      expect(result!.scope.orElse("")).toBe("config")
      expect(result!.breaking).toBe(true)
      expect(result!.description).toBe("change config format")
    })

    it("should return null for non-conventional commits", () => {
      expect(parseConventionalCommit("just a message")).toBeNull()
      expect(parseConventionalCommit("bump")).toBeNull()
      expect(parseConventionalCommit("2.6.1")).toBeNull()
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

    it("should accept --since flag", () => {
      const output = execSync(`node ${cliPath} changelog --since v2.5.2 --version 2.6.1`, {
        encoding: "utf-8",
      })
      expect(output.length).toBeGreaterThan(0)
    })
  })
})
