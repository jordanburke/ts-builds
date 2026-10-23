import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it } from "vitest"

import type { PnpmReleaseAgeProbe } from "../src/cli/pnpm11"
import {
  buildReleaseAgeExcludeLine,
  defaultReleaseAgeProbe,
  detectPnpm11Issues,
  migratePnpm11,
  parseReleaseAgeViolations,
  readAllowBuildsKeys,
} from "../src/cli/pnpm11"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ts-builds-pnpm11-"))
}

// No-op probe so the non-release-age tests stay deterministic and never shell
// out to real pnpm. Release-age behaviour is exercised by its own tests below.
const noReleaseAgeProbe: PnpmReleaseAgeProbe = () => ({ stdout: "", stderr: "", status: 0 })

describe("detectPnpm11Issues", () => {
  it("warns about public-hoist-pattern lines in .npmrc with a count", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=typescript\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("2 hoist pattern(s) in .npmrc")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about a package.json pnpm field", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { a: "1" } } }))
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("package.json 'pnpm' field")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about both surfaces when both are present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { a: "1" } } }))
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.severity === "warning")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports ready when neither surface is present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("info")
      expect(results[0].message).toBe("pnpm 11 ready")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns with the exact pkg@version when the probe reports a release-age violation", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const probe: PnpmReleaseAgeProbe = () => ({
        stdout: "",
        stderr:
          "[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:\n" +
          "  left-pad@1.3.0 was published at 2018-04-09T01:10:45.796Z, within the minimumReleaseAge cutoff (2026-06-05T00:00:00.000Z)\n",
        status: 1,
      })
      const results = detectPnpm11Issues(dir, probe).toArray()
      const warning = results.find((r) => r.message.includes("left-pad@1.3.0"))
      expect(warning).toBeDefined()
      expect(warning?.severity).toBe("warning")
      expect(warning?.message).toContain("minimumReleaseAgeExclude")
      expect(warning?.message).toContain("left-pad@1.3.0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not emit a release-age warning when the probe reports no violation", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const probe: PnpmReleaseAgeProbe = () => ({ stdout: "", stderr: "", status: 0 })
      const results = detectPnpm11Issues(dir, probe).toArray()
      expect(results.some((r) => r.message.includes("minimumReleaseAge"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns that the check could not run when pnpm fails without reporting a violation", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const probe: PnpmReleaseAgeProbe = () => ({
        stdout: "",
        stderr: "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/nope: Not Found",
        status: 1,
      })
      const results = detectPnpm11Issues(dir, probe).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toBe(
        "Could not check minimumReleaseAge: `pnpm install --lockfile-only` exited 1: " +
          "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/nope: Not Found",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not report ready when pnpm rejects the probe's own flags (#206)", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      // Real pnpm 12.15.0 output for the `--resolution-only` flag it removed.
      const probe: PnpmReleaseAgeProbe = () => ({
        stdout: "",
        stderr:
          "error: unexpected argument '--resolution-only' found\n\n" +
          "  tip: a similar argument exists: '--production'\n\n" +
          "Usage: pnpm install --prod\n\nFor more information, try '--help'.\n",
        status: 2,
      })
      const results = detectPnpm11Issues(dir, probe).toArray()
      expect(results.some((r) => r.message === "pnpm 11 ready")).toBe(false)
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("warning")
      expect(results[0].message).toContain("exited 2: error: unexpected argument '--resolution-only' found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("stays quiet when pnpm is not installed (probe status -1)", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const probe: PnpmReleaseAgeProbe = () => ({ stdout: "", stderr: "", status: -1 })
      const results = detectPnpm11Issues(dir, probe).toArray()
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe("info")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parseReleaseAgeViolations", () => {
  it("extracts a single pkg@version from real pnpm 11 stderr", () => {
    const stderr =
      "[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:\n" +
      "  left-pad@1.3.0 was published at 2018-04-09T01:10:45.796Z, within the minimumReleaseAge cutoff (2026-06-05T00:00:00.000Z)\n"
    expect(parseReleaseAgeViolations("", stderr)).toEqual(["left-pad@1.3.0"])
  })

  it("extracts multiple pkg@version entries preserving order and de-duplicating", () => {
    const stderr =
      "[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 3 versions do not meet the minimumReleaseAge constraint:\n" +
      "  is-number@6.0.0 was published at 2018-03-31T17:02:39.953Z, within the minimumReleaseAge cutoff (X)\n" +
      "  is-odd@3.0.1 was published at 2018-05-31T20:04:53.306Z, within the minimumReleaseAge cutoff (X)\n" +
      "  left-pad@1.3.0 was published at 2018-04-09T01:10:45.796Z, within the minimumReleaseAge cutoff (X)\n" +
      "  is-odd@3.0.1 was published at 2018-05-31T20:04:53.306Z, within the minimumReleaseAge cutoff (X)\n"
    expect(parseReleaseAgeViolations("", stderr)).toEqual(["is-number@6.0.0", "is-odd@3.0.1", "left-pad@1.3.0"])
  })

  it("handles scoped packages", () => {
    const stderr =
      "  @eslint/js@9.0.0 was published at 2026-06-05T00:00:00.000Z, within the minimumReleaseAge cutoff (X)\n"
    expect(parseReleaseAgeViolations("", stderr)).toEqual(["@eslint/js@9.0.0"])
  })

  it("matches on the per-violation line, independent of the header error code", () => {
    // Robustness: we key off the line wording ("... was published ... minimumReleaseAge"),
    // not the header code, so a future pnpm code/format tweak still parses.
    const stderr = "[ERR_PNPM_SOME_FUTURE_CODE] foo@2.1.0 was published within the minimumReleaseAge cutoff\n"
    expect(parseReleaseAgeViolations("", stderr)).toEqual(["foo@2.1.0"])
  })

  it("extracts a violation from real pnpm 12 strict-mode stderr, which word-wraps it", () => {
    // Captured from pnpm 12.15.0 with `minimumReleaseAgeStrict: true`: the violation
    // is split across two lines, between "within the" and "minimumReleaseAge".
    const stderr =
      "Error: ERR_PNPM_NO_MATURE_MATCHING_VERSION\n\n" +
      "  × installing dependencies\n" +
      "  ╰─▶ 1 version does not meet the minimumReleaseAge constraint:\n" +
      "        tsdown@0.23.2 was published at 2026-10-23T12:50:53.747Z, within the\n" +
      "      minimumReleaseAge cutoff (2026-10-22T21:31:09.103Z)\n" +
      "  help: Run the install interactively to approve these picks, add them to\n" +
      "        minimumReleaseAgeExclude in pnpm-workspace.yaml, or wait for the\n" +
      "        packages to mature.\n"
    expect(parseReleaseAgeViolations("", stderr)).toEqual(["tsdown@0.23.2"])
  })

  it("extracts the entries pnpm auto-excludes in lenient (default) mode", () => {
    // Captured from pnpm 11.27.0 and 12.15.0 (identical apart from the leading
    // blank line): the install succeeds and pnpm writes the entry itself.
    const stdout =
      "\nAdded 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml " +
      "(set minimumReleaseAgeStrict to true to gate these updates with a prompt):\n" +
      "  tsdown@0.23.2\n" +
      "Done in 368ms using pnpm v11.27.0\n"
    expect(parseReleaseAgeViolations(stdout, "")).toEqual(["tsdown@0.23.2"])
  })

  it("extracts several lenient-mode entries, scoped ones included, and stops at the block's end", () => {
    const stdout =
      "Added 2 entries to minimumReleaseAgeExclude in pnpm-workspace.yaml (...):\n" +
      "  @types/node@26.6.6\n" +
      "  tsdown@0.23.2\n" +
      "Done in 25ms using pnpm v12.15.0\n" +
      "  unrelated@1.0.0\n"
    expect(parseReleaseAgeViolations(stdout, "")).toEqual(["@types/node@26.6.6", "tsdown@0.23.2"])
  })

  it("returns no violations for unrelated error output", () => {
    expect(
      parseReleaseAgeViolations("", "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/nope: Not Found"),
    ).toEqual([])
  })

  it("returns no violations for empty output", () => {
    expect(parseReleaseAgeViolations("", "")).toEqual([])
  })
})

describe("buildReleaseAgeExcludeLine", () => {
  it("renders a minimumReleaseAgeExclude suggestion naming the pkg@version", () => {
    const line = buildReleaseAgeExcludeLine("left-pad@1.3.0")
    expect(line).toContain("minimumReleaseAgeExclude")
    expect(line).toContain("left-pad@1.3.0")
  })
})

// ─── B2: allowBuilds / esbuild detection ────────────────────────────────────

describe("readAllowBuildsKeys", () => {
  it("returns empty set when allowBuilds block is absent", () => {
    const yaml = "packages:\n  - '**'\n"
    expect(readAllowBuildsKeys(yaml).size).toBe(0)
  })

  it("parses a single key", () => {
    const yaml = "allowBuilds:\n  esbuild: false\n"
    const keys = readAllowBuildsKeys(yaml)
    expect(keys.has("esbuild")).toBe(true)
    expect(keys.size).toBe(1)
  })

  it("parses multiple keys (true and false values)", () => {
    const yaml = "allowBuilds:\n  esbuild: false\n  some-other: true\n"
    const keys = readAllowBuildsKeys(yaml)
    expect(keys.has("esbuild")).toBe(true)
    expect(keys.has("some-other")).toBe(true)
    expect(keys.size).toBe(2)
  })

  it("stops parsing allowBuilds block at the next top-level key", () => {
    const yaml = "allowBuilds:\n  esbuild: false\noverrides:\n  foo: '1'\n"
    const keys = readAllowBuildsKeys(yaml)
    expect(keys.has("esbuild")).toBe(true)
    expect(keys.has("overrides")).toBe(false)
    expect(keys.size).toBe(1)
  })

  it("returns empty set for empty string", () => {
    expect(readAllowBuildsKeys("").size).toBe(0)
  })
})

// Minimal pnpm-lock.yaml v9 snippet that places esbuild under packages:
const LOCKFILE_WITH_ESBUILD = `lockfileVersion: '9.0'

packages:
  esbuild@0.25.4:
    resolution: {integrity: sha512-xxx}

  typescript@5.8.3:
    resolution: {integrity: sha512-yyy}

snapshots:
  esbuild@0.25.4:
    dependencies: {}
`

const LOCKFILE_WITHOUT_ESBUILD = `lockfileVersion: '9.0'

packages:
  typescript@5.8.3:
    resolution: {integrity: sha512-yyy}
`

describe("detectPnpm11Issues — B2 esbuild allowBuilds detection", () => {
  it("warns and proposes allowBuilds.esbuild:false when esbuild in lockfile but no allowBuilds declared", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      const warning = results.find((r) => r.message.includes("esbuild"))
      expect(warning).toBeDefined()
      expect(warning?.severity).toBe("warning")
      expect(warning?.message).toContain("ERR_PNPM_IGNORED_BUILDS")
      expect(warning?.message).toContain("allowBuilds:")
      expect(warning?.message).toContain("esbuild: false")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT warn when esbuild is already declared under allowBuilds (false)", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\nallowBuilds:\n  esbuild: false\n")
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results.some((r) => r.message.includes("esbuild"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT warn when esbuild is declared under allowBuilds (true)", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\nallowBuilds:\n  esbuild: true\n")
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results.some((r) => r.message.includes("esbuild"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT warn when no lockfile is present", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      // no pnpm-lock.yaml
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results.some((r) => r.message.includes("esbuild"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT warn when lockfile exists but esbuild is not present in it", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITHOUT_ESBUILD)
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      expect(results.some((r) => r.message.includes("esbuild"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT warn when no pnpm-workspace.yaml exists but allowBuilds is also absent (no workspace = no strictDepBuilds context)", () => {
    // When there's no workspace file at all, esbuild in the lockfile is still
    // un-decided. We DO warn because strictDepBuilds defaults to true in pnpm 11
    // even without a workspace file — the user needs to add allowBuilds somewhere.
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      // no pnpm-workspace.yaml at all
      const results = detectPnpm11Issues(dir, noReleaseAgeProbe).toArray()
      const warning = results.find((r) => r.message.includes("esbuild"))
      expect(warning).toBeDefined()
      expect(warning?.severity).toBe("warning")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("migratePnpm11", () => {
  it("migrates .npmrc hoist patterns to pnpm-workspace.yaml and removes the emptied .npmrc", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, ".npmrc"),
        "# Hoist CLI tool binaries from peer dependencies\npublic-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=typescript\n",
      )
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const report = migratePnpm11(dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("publicHoistPattern:")
      expect(ws).toContain(`  - "*eslint*"`)
      expect(ws).toContain(`  - "typescript"`)
      expect(existsSync(join(dir, ".npmrc"))).toBe(false)
      expect(report.actions.some((a) => a.kind === "migrated")).toBe(true)
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves non-hoist .npmrc lines", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "registry=https://example.com/\npublic-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      migratePnpm11(dir)
      const npmrc = readFileSync(join(dir, ".npmrc"), "utf-8")
      expect(npmrc).toContain("registry=https://example.com/")
      expect(npmrc).not.toContain("public-hoist-pattern")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("migrates known pnpm field keys and prunes the field", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          pnpm: { overrides: { foo: "1.0.0" }, peerDependencyRules: { allowedVersions: { eslint: "10" } } },
        }),
      )
      const report = migratePnpm11(dir)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("overrides:")
      expect(ws).toContain(`  "foo": "1.0.0"`)
      expect(ws).toContain("peerDependencyRules:")
      expect(ws).toContain("  allowedVersions:")
      expect(ws).toContain(`    "eslint": "10"`)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toBeUndefined()
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports exotic pnpm keys as manual and keeps them in package.json", () => {
    const dir = tmp()
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", pnpm: { overrides: { foo: "1" }, packageExtensions: { bar: {} } } }),
      )
      const report = migratePnpm11(dir)
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
      expect(pkg.pnpm).toEqual({ packageExtensions: { bar: {} } })
      expect(report.actions.some((a) => a.kind === "manual" && a.message.includes("packageExtensions"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips when a target key already exists in pnpm-workspace.yaml and leaves .npmrc intact", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), `publicHoistPattern:\n  - "existing"\n`)
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const report = migratePnpm11(dir)
      expect(existsSync(join(dir, ".npmrc"))).toBe(true)
      expect(report.actions.some((a) => a.kind === "skipped")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent — a second run with nothing to migrate makes no changes", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      migratePnpm11(dir)
      const wsAfterFirst = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      const report2 = migratePnpm11(dir)
      const wsAfterSecond = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(wsAfterSecond).toBe(wsAfterFirst)
      expect(report2.actions.length).toBe(0)
      expect(report2.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not touch .npmrc when the pnpm-workspace.yaml write fails", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      // Force the ws write to fail by making the path a directory (EISDIR).
      mkdirSync(join(dir, "pnpm-workspace.yaml"))
      const report = migratePnpm11(dir)
      expect(report.errors).toBeGreaterThan(0)
      // .npmrc must be preserved — no data loss.
      expect(readFileSync(join(dir, ".npmrc"), "utf-8")).toContain("public-hoist-pattern[]=*eslint*")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── B3: --fix writes minimumReleaseAgeExclude + allowBuilds entries ─────────

// Count occurrences of a top-level key (anchored line start, ends with colon).
function topLevelKeyCount(yaml: string, key: string): number {
  return (yaml.match(new RegExp(`^${key}:`, "gm")) ?? []).length
}

function probeReporting(...tokens: string[]): PnpmReleaseAgeProbe {
  return () => ({
    stdout: "",
    stderr: tokens
      .map((t) => `  ${t} was published at 2026-06-05T00:00:00.000Z, within the minimumReleaseAge cutoff (X)`)
      .join("\n"),
    status: tokens.length > 0 ? 1 : 0,
  })
}

describe("migratePnpm11 — B3 minimumReleaseAgeExclude", () => {
  it("appends a new block with a PINNED entry for a non-first-party violation", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      const report = migratePnpm11(dir, probeReporting("@types/node@24.13.1"))
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("minimumReleaseAgeExclude:")
      expect(ws).toContain(`  - "@types/node@24.13.1"`)
      expect(report.actions.some((a) => a.kind === "migrated" && a.message.includes("minimumReleaseAgeExclude"))).toBe(
        true,
      )
      expect(report.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses the *functype* glob for a first-party functype-family violation", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      migratePnpm11(dir, probeReporting("functype-os@1.2.3"))
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("minimumReleaseAgeExclude:")
      expect(ws).toContain(`  - "*functype*"`)
      expect(ws).not.toContain("functype-os@1.2.3")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("collapses the whole functype family (incl. eslint-config/plugin-functype) to one *functype* glob and uses bare ts-builds", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      migratePnpm11(
        dir,
        probeReporting(
          "functype@1.4.1",
          "functype-os@1.4.1",
          "eslint-config-functype@2.104.1",
          "eslint-plugin-functype@2.104.1",
          "ts-builds@3.1.1",
        ),
      )
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      // All four functype-family packages collapse to a single glob entry.
      expect(ws.match(/- "\*functype\*"/g)?.length).toBe(1)
      expect(ws).toContain("  - ts-builds")
      // None of the first-party packages are pinned to a version.
      expect(ws).not.toMatch(/functype@|functype-os@|eslint-(config|plugin)-functype@|ts-builds@/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inserts into an EXISTING block, preserving entries and not duplicating the top-level key", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        `packages:\n  - '**'\nminimumReleaseAgeExclude:\n  - "already@1.0.0"\n  - functype\n`,
      )
      migratePnpm11(dir, probeReporting("@types/node@24.13.1"))
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(topLevelKeyCount(ws, "minimumReleaseAgeExclude")).toBe(1)
      expect(ws).toContain(`  - "already@1.0.0"`)
      expect(ws).toContain("  - functype")
      expect(ws).toContain(`  - "@types/node@24.13.1"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not add a pinned entry when its bare name is already excluded", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        `packages:\n  - '**'\nminimumReleaseAgeExclude:\n  - functype-os\n`,
      )
      // functype-os is first-party → maps to bare "functype-os", already present.
      const report = migratePnpm11(dir, probeReporting("functype-os@9.9.9"))
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).not.toContain("functype-os@9.9.9")
      // Nothing new to add for the release-age dimension.
      expect(report.actions.some((a) => a.message.includes("minimumReleaseAgeExclude") && a.kind === "migrated")).toBe(
        false,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("adds no release-age entries when the probe reports nothing", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      const report = migratePnpm11(dir, noReleaseAgeProbe)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).not.toContain("minimumReleaseAgeExclude")
      expect(report.actions.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a skipped step, not a clean run, when the probe could not run", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      const probe: PnpmReleaseAgeProbe = () => ({ stdout: "", stderr: "error: unexpected argument", status: 2 })
      const report = migratePnpm11(dir, probe)
      expect(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")).toBe("packages:\n  - '**'\n")
      expect(report.errors).toBe(0)
      expect(report.actions).toEqual([
        {
          kind: "skipped",
          message:
            "Could not check minimumReleaseAge: `pnpm install --lockfile-only` exited 2: error: unexpected argument",
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("migratePnpm11 — B3 allowBuilds", () => {
  it("appends allowBuilds.esbuild:false when esbuild is in the lockfile and undecided", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      const report = migratePnpm11(dir, noReleaseAgeProbe)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("allowBuilds:")
      expect(ws).toContain("  esbuild: false")
      expect(report.actions.some((a) => a.kind === "migrated" && a.message.includes("allowBuilds"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("makes no allowBuilds change when esbuild is already decided", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\nallowBuilds:\n  esbuild: false\n")
      const report = migratePnpm11(dir, noReleaseAgeProbe)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(topLevelKeyCount(ws, "allowBuilds")).toBe(1)
      expect((ws.match(/esbuild: false/g) ?? []).length).toBe(1)
      expect(report.actions.some((a) => a.message.includes("allowBuilds"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inserts into an EXISTING allowBuilds block without duplicating the top-level key", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\nallowBuilds:\n  some-other: true\n")
      migratePnpm11(dir, noReleaseAgeProbe)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(topLevelKeyCount(ws, "allowBuilds")).toBe(1)
      expect(ws).toContain("  some-other: true")
      expect(ws).toContain("  esbuild: false")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("adds no allowBuilds entries when there is no lockfile", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")
      migratePnpm11(dir, noReleaseAgeProbe)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).not.toContain("allowBuilds")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("migratePnpm11 — block (d) reads the lockfile before the probe runs (Bug 2)", () => {
  it("writes allowBuilds.esbuild:false even when the probe mutates the lockfile away", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")

      // Simulate the real Bug 2: the probe clobbers the consumer lockfile (as an
      // unrestored `pnpm install --lockfile-only` would) and reports no
      // release-age violations. Block (d) must NOT depend on the post-probe
      // lockfile — it must use the contents read before the probe ran.
      const mutatingProbe: PnpmReleaseAgeProbe = () => {
        writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITHOUT_ESBUILD)
        return { stdout: "", stderr: "", status: 0 }
      }

      const report = migratePnpm11(dir, mutatingProbe)
      const ws = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws).toContain("allowBuilds:")
      expect(ws).toContain("  esbuild: false")
      expect(report.actions.some((a) => a.kind === "migrated" && a.message.includes("allowBuilds"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("defaultReleaseAgeProbe — side-effect-free (Bug 1)", () => {
  it("leaves an existing pnpm-lock.yaml byte-for-byte unchanged after probing", () => {
    const dir = tmp()
    try {
      // Trivial manifest so pnpm (if present) has something to resolve, and a
      // lockfile with sentinel bytes the real probe could otherwise rewrite.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe-fixture", version: "0.0.0" }))
      const lockPath = join(dir, "pnpm-lock.yaml")
      const sentinel = "lockfileVersion: '9.0'\n\n# sentinel-do-not-rewrite\nsettings:\n  autoInstallPeers: true\n"
      writeFileSync(lockPath, sentinel)
      const before = readFileSync(lockPath)

      // Real probe — shells out to pnpm. If pnpm is missing it returns status -1
      // and never mutated anything; if present it may try to rewrite, and the
      // snapshot/restore must put the bytes back. The invariant holds either way.
      defaultReleaseAgeProbe(dir)

      const after = readFileSync(lockPath)
      expect(after.equals(before)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A stand-in `pnpm` on PATH that records its arguments, rewrites or creates every
  // file in $FAKE_PNPM_WRITES (as real pnpm does to the lockfile, and to
  // pnpm-workspace.yaml in lenient mode), and prints pnpm's lenient-mode output.
  // Deterministic: no network, and no dependence on a package being days old.
  function withFakePnpm(writes: string[], run: (argsFile: string) => void): void {
    const bin = tmp()
    const argsFile = join(bin, "args.txt")
    writeFileSync(
      join(bin, "pnpm"),
      "#!/bin/sh\n" +
        'printf "%s" "$*" > "$FAKE_PNPM_ARGS"\n' +
        'for f in $FAKE_PNPM_WRITES; do printf "written-by-pnpm\\n" >> "$f"; done\n' +
        'printf "Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (...):\\n  left-pad@1.3.0\\n"\n',
      { mode: 0o755 },
    )
    const saved = { PATH: process.env.PATH, args: process.env.FAKE_PNPM_ARGS, writes: process.env.FAKE_PNPM_WRITES }
    process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`
    process.env.FAKE_PNPM_ARGS = argsFile
    process.env.FAKE_PNPM_WRITES = writes.join(" ")
    try {
      run(argsFile)
    } finally {
      process.env.PATH = saved.PATH
      if (saved.args === undefined) delete process.env.FAKE_PNPM_ARGS
      else process.env.FAKE_PNPM_ARGS = saved.args
      if (saved.writes === undefined) delete process.env.FAKE_PNPM_WRITES
      else process.env.FAKE_PNPM_WRITES = saved.writes
      rmSync(bin, { recursive: true, force: true })
    }
  }

  it.skipIf(process.platform === "win32")(
    "runs `pnpm install --lockfile-only` and restores pnpm-workspace.yaml and the lockfile it writes",
    () => {
      const dir = tmp()
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe-fixture", version: "0.0.0" }))
        const lockPath = join(dir, "pnpm-lock.yaml")
        writeFileSync(lockPath, "lockfileVersion: '9.0'\n")
        const wsPath = join(dir, "pnpm-workspace.yaml")
        // No pnpm-workspace.yaml before the probe: lenient pnpm creates one.
        withFakePnpm([lockPath, wsPath], (argsFile) => {
          const result = defaultReleaseAgeProbe(dir)
          expect(readFileSync(argsFile, "utf-8")).toBe("install --lockfile-only")
          expect(parseReleaseAgeViolations(result.stdout, result.stderr)).toEqual(["left-pad@1.3.0"])
        })
        expect(readFileSync(lockPath, "utf-8")).toBe("lockfileVersion: '9.0'\n")
        expect(existsSync(wsPath)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === "win32")(
    "restores the workspace root's files when probing from a package inside a workspace",
    () => {
      const root = tmp()
      try {
        const rootWs = join(root, "pnpm-workspace.yaml")
        const rootLock = join(root, "pnpm-lock.yaml")
        writeFileSync(rootWs, "packages:\n  - 'packages/*'\n")
        writeFileSync(rootLock, "lockfileVersion: '9.0'\n")
        const pkgDir = join(root, "packages", "a")
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "a", version: "0.0.0" }))
        withFakePnpm([rootWs, rootLock], () => {
          defaultReleaseAgeProbe(pkgDir)
        })
        expect(readFileSync(rootWs, "utf-8")).toBe("packages:\n  - 'packages/*'\n")
        expect(readFileSync(rootLock, "utf-8")).toBe("lockfileVersion: '9.0'\n")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

describe("migratePnpm11 — B3 integration & idempotence (acceptance proxy)", () => {
  // The real `pnpm install` clean-run verification is done manually in B4.
  // Here the deterministic stand-in for "clean" is: each top-level key appears
  // at most once, and a second migrate with the same probe is a no-op.
  it("produces single top-level keys and is idempotent across all surfaces", () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", pnpm: { overrides: { foo: "1.0.0" } } }))
      writeFileSync(join(dir, ".npmrc"), "public-hoist-pattern[]=*eslint*\n")
      writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE_WITH_ESBUILD)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '**'\n")

      const probe = probeReporting("@types/node@24.13.1", "functype@1.5.0")
      const report1 = migratePnpm11(dir, probe)
      const ws1 = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")

      // Each top-level key at most once.
      for (const key of ["publicHoistPattern", "overrides", "minimumReleaseAgeExclude", "allowBuilds"]) {
        expect(topLevelKeyCount(ws1, key)).toBe(1)
      }
      // Pinned (third-party) vs *functype* glob (first-party) per the exclude rule.
      expect(ws1).toContain(`  - "@types/node@24.13.1"`)
      expect(ws1).toContain(`  - "*functype*"`)
      expect(ws1).not.toContain("functype@1.5.0")
      expect(ws1).toContain("  esbuild: false")
      expect(report1.errors).toBe(0)

      // Idempotence: a second run with the same probe is a no-op.
      const report2 = migratePnpm11(dir, probe)
      const ws2 = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf-8")
      expect(ws2).toBe(ws1)
      expect(report2.actions.length).toBe(0)
      expect(report2.errors).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
