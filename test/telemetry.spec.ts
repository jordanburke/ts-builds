import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ESLint, Linter } from "eslint"
import { afterEach, describe, expect, it } from "vitest"

import { Option } from "functype"

import {
  activeConfig,
  buildTelemetryPayload,
  detectAgent,
  fitTrace,
  gitTrace,
  installedVersion,
  isCi,
  isTraceRepo,
  MAX_TRACE_FINDINGS,
  messageStats,
  normalizeRemote,
  pluginPackage,
  projectId,
  reportLintTelemetry,
  ruleStats,
  sendTelemetry,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryPayload,
  telemetryMode,
  traceCandidates,
  traceOn,
} from "../src/cli/telemetry"

const message = (ruleId: string | null, severity: 1 | 2, text = "a message"): Linter.LintMessage =>
  ({ ruleId, severity, message: text, line: 1, column: 1 }) as Linter.LintMessage

const suppressed = (ruleId: string | null, kind: "directive" | "file"): Linter.SuppressedLintMessage =>
  ({ ...message(ruleId, 2), suppressions: [{ kind, justification: "" }] }) as Linter.SuppressedLintMessage

function result(over: Partial<ESLint.LintResult>): ESLint.LintResult {
  return {
    filePath: "/repo/src/secret-name.ts",
    messages: [],
    suppressedMessages: [],
    errorCount: 0,
    fatalErrorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
    ...over,
  } as ESLint.LintResult
}

describe("ruleStats", () => {
  it("counts errors, warnings and silenced findings per rule", () => {
    const stats = ruleStats([
      result({
        messages: [message("functype/prefer-option", 2), message("functype/prefer-option", 1), message("no-var", 2)],
        suppressedMessages: [
          suppressed("functype/prefer-option", "directive"),
          suppressed("functype/prefer-option", "file"),
        ],
      }),
      result({ messages: [message("functype/prefer-option", 2)] }),
    ])
    expect(stats.rules).toEqual({
      "functype/prefer-option": { errors: 2, warnings: 1, silenced: 2 },
      "no-var": { errors: 1, warnings: 0, silenced: 0 },
    })
    expect(stats.fatal).toBe(0)
  })

  it("counts a message with no rule id as fatal, not as a rule", () => {
    const stats = ruleStats([result({ messages: [message(null, 2), message("no-var", 2)] })])
    expect(stats.fatal).toBe(1)
    expect(Object.keys(stats.rules)).toEqual(["no-var"])
  })

  it("ignores a suppressed message with no rule id", () => {
    expect(ruleStats([result({ suppressedMessages: [suppressed(null, "directive")] })]).rules).toEqual({})
  })

  it("sorts rule ids, so the same results always serialize the same way", () => {
    const stats = ruleStats([result({ messages: [message("z/b", 2), message("a/c", 2), message("m", 2)] })])
    expect(Object.keys(stats.rules)).toEqual(["a/c", "m", "z/b"])
  })

  it("gives empty counts for no results", () => {
    expect(ruleStats([])).toEqual({ rules: {}, fatal: 0 })
  })
})

describe("telemetryMode", () => {
  const url = "https://telemetry.example.com/v1/lint"

  it.each([
    ["nothing set", {}, "off"],
    ["TS_BUILDS_TELEMETRY=0", { TS_BUILDS_TELEMETRY: "0", TS_BUILDS_TELEMETRY_URL: url }, "off"],
    ["TS_BUILDS_TELEMETRY=1 with a URL", { TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: url }, "send"],
    ["TS_BUILDS_TELEMETRY=true with a URL", { TS_BUILDS_TELEMETRY: "true", TS_BUILDS_TELEMETRY_URL: url }, "send"],
    [
      "DO_NOT_TRACK=1 beats TS_BUILDS_TELEMETRY",
      { DO_NOT_TRACK: "1", TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: url },
      "off",
    ],
    ["DO_NOT_TRACK=1 beats debug", { DO_NOT_TRACK: "1", TS_BUILDS_TELEMETRY_DEBUG: "1" }, "off"],
    ["debug alone prints", { TS_BUILDS_TELEMETRY_DEBUG: "1" }, "debug"],
    [
      "debug beats send, so nothing goes out",
      { TS_BUILDS_TELEMETRY_DEBUG: "1", TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: url },
      "debug",
    ],
  ])("%s → %s", (_label, env, kind) => {
    expect(telemetryMode(env).kind).toBe(kind)
  })

  it("warns, and sends nothing, when it's on without a URL", () => {
    const mode = telemetryMode({ TS_BUILDS_TELEMETRY: "1" })
    expect(mode).toEqual({ kind: "off", warning: expect.stringContaining("TS_BUILDS_TELEMETRY_URL") })
  })

  it.each(["http://telemetry.example.com/v1", "ftp://example.com", "not a url"])(
    "refuses %s, which isn't https or a local http URL",
    (endpoint) => {
      const mode = telemetryMode({ TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: endpoint })
      expect(mode).toEqual({ kind: "off", warning: expect.stringContaining("https") })
    },
  )

  it.each(["http://localhost:8787/v1", "http://127.0.0.1:9/x", "http://[::1]:9/x"])(
    "allows local http %s",
    (endpoint) => {
      expect(telemetryMode({ TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: endpoint })).toEqual({
        kind: "send",
        endpoint,
      })
    },
  )
})

describe("normalizeRemote and projectId", () => {
  it.each([
    "git@github.com:jordanburke/functype.git",
    "https://github.com/jordanburke/functype.git",
    "https://user:token@github.com/jordanburke/functype",
    "ssh://git@github.com/jordanburke/functype",
    "ssh://git@github.com:22/jordanburke/functype.git",
    "https://GitHub.com/JordanBurke/functype/",
  ])("reduces %s to host/owner/repo", (remote) => {
    expect(normalizeRemote(remote)).toBe("github.com/jordanburke/functype")
  })

  it("gives the same id for every spelling of one remote, and never contains the URL", () => {
    const ids = ["git@github.com:jordanburke/functype.git", "https://user:token@github.com/jordanburke/functype"].map(
      projectId,
    )
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/)
  })

  it("gives different ids for different repos", () => {
    expect(projectId("git@github.com:a/one.git")).not.toBe(projectId("git@github.com:a/two.git"))
  })
})

describe("pluginPackage", () => {
  it.each([
    ["functype/prefer-option", "eslint-plugin-functype"],
    ["@typescript-eslint/no-unused-vars", "@typescript-eslint/eslint-plugin"],
    ["@scope/name/rule", "@scope/eslint-plugin-name"],
    ["@scope/rule", "@scope/eslint-plugin"],
    ["a/b/c", "eslint-plugin-a"],
  ])("%s comes from %s", (ruleId, pkg) => {
    expect(pluginPackage(ruleId).orElse("none")).toBe(pkg)
  })

  it("has no plugin for a core rule", () => {
    expect(pluginPackage("no-var").isNone()).toBe(true)
  })
})

describe("environment detection", () => {
  it("detects Claude Code from CLAUDECODE=1", () => {
    expect(detectAgent({ CLAUDECODE: "1" }).orElse("none")).toBe("claude-code")
    expect(detectAgent({}).isNone()).toBe(true)
  })

  it.each([
    [{ CI: "true" }, true],
    [{ CI: "1" }, true],
    [{ GITHUB_ACTIONS: "true" }, true],
    [{ CI: "false" }, false],
    [{}, false],
  ])("isCi(%j) is %s", (env, expected) => {
    expect(isCi(env)).toBe(expected)
  })
})

describe("installedVersion", () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  it("finds a package in an ancestor's node_modules, the way Node does", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-builds-telemetry-"))
    dirs.push(root)
    mkdirSync(join(root, "node_modules", "eslint-plugin-x"), { recursive: true })
    writeFileSync(join(root, "node_modules", "eslint-plugin-x", "package.json"), JSON.stringify({ version: "2.3.4" }))
    mkdirSync(join(root, "packages", "a"), { recursive: true })
    expect(installedVersion("eslint-plugin-x", join(root, "packages", "a")).orElse("none")).toBe("2.3.4")
    expect(installedVersion("eslint-plugin-missing", join(root, "packages", "a")).isNone()).toBe(true)
  })

  it("finds a dependency beside a package in pnpm's layout", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-builds-telemetry-"))
    dirs.push(root)
    const store = join(root, "node_modules", ".pnpm", "ts-builds@4.2.0", "node_modules")
    mkdirSync(join(store, "ts-builds"), { recursive: true })
    mkdirSync(join(store, "eslint-plugin-y"), { recursive: true })
    writeFileSync(join(store, "eslint-plugin-y", "package.json"), JSON.stringify({ version: "5.6.7" }))
    expect(installedVersion("eslint-plugin-y", join(store, "ts-builds")).orElse("none")).toBe("5.6.7")
  })
})

describe("activeConfig", () => {
  const calculated = {
    plugins: {
      "@": {},
      functype: { meta: { name: "eslint-plugin-functype", version: "2.0.0" } },
      "@typescript-eslint": { meta: { name: "@typescript-eslint/eslint-plugin", version: "8.71.0" } },
      nameless: {},
    },
    rules: {
      "no-var": [2],
      "functype/prefer-option": [1],
      "functype/no-let": "error",
      "functype/prefer-list": [0],
      "@typescript-eslint/no-explicit-any": ["off"],
    },
  }

  it("lists each configured plugin by its package name, skipping ESLint's own namespace", () => {
    const active = activeConfig(calculated)
    expect(active.plugins.map((p) => p.name)).toEqual([
      "eslint-plugin-functype",
      "@typescript-eslint/eslint-plugin",
      "eslint-plugin-nameless",
    ])
    expect(active.plugins[0]?.metaVersion.orElse("none")).toBe("2.0.0")
    expect(active.plugins[2]?.metaVersion.isNone()).toBe(true)
  })

  it("keeps plugin rules that are on, with their severity, and drops core and off rules", () => {
    expect(activeConfig(calculated).enabled).toEqual({ "functype/no-let": "error", "functype/prefer-option": "warn" })
  })

  it("ignores a meta name that isn't a package name, and a meta version that isn't semver", () => {
    const active = activeConfig({
      plugins: { local: { meta: { name: "/Users/someone/secret-plugin", version: "1.0.0-see-/Users/someone/x" } } },
    })
    expect(active.plugins.map((p) => p.name)).toEqual(["eslint-plugin-local"])
    expect(active.plugins[0]?.metaVersion.isNone()).toBe(true)
  })

  it("gives nothing for a config it can't read", () => {
    expect(activeConfig(undefined)).toEqual({ plugins: [], enabled: {} })
    expect(activeConfig({ plugins: 3, rules: "x" })).toEqual({ plugins: [], enabled: {} })
  })
})

describe("buildTelemetryPayload", () => {
  const run = {
    results: [
      result({
        messages: [message("no-var", 2, "TOKEN=hunter2 in a message")],
        source: "const secret = 'hunter2'",
      }),
    ],
    fix: false,
    durationMs: 12.6,
    packageName: Option("@fixture/pkg"),
    eslintVersion: "10.0.0",
    dir: tmpdir(),
  }

  it("holds counts and versions, rounded, with the schema version", () => {
    const payload = buildTelemetryPayload(run, { CI: "true", CLAUDECODE: "1" })
    expect(payload).toMatchObject({
      schema: TELEMETRY_SCHEMA_VERSION,
      package: "@fixture/pkg",
      ci: true,
      agent: "claude-code",
      fix: false,
      durationMs: 13,
      files: 1,
      fatal: 0,
      rules: { "no-var": { errors: 1, warnings: 0, silenced: 0 } },
    })
    expect(payload.versions).toMatchObject({ node: process.versions.node, eslint: "10.0.0" })
    expect(payload.versions["ts-builds"]).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("never carries a file path, source or message text", () => {
    const json = JSON.stringify(buildTelemetryPayload(run, {}))
    expect(json).not.toContain("secret-name")
    expect(json).not.toContain("hunter2")
    expect(json).not.toContain("/repo/")
  })

  it("leaves out agent when no agent is detected", () => {
    expect(buildTelemetryPayload(run, {})).not.toHaveProperty("agent")
  })

  it("leaves out package when package.json has no name", () => {
    expect(buildTelemetryPayload({ ...run, packageName: Option.none<string>() }, {})).not.toHaveProperty("package")
  })

  it("leaves out enabled when the config couldn't be read", () => {
    expect(buildTelemetryPayload(run, {})).not.toHaveProperty("enabled")
  })

  it("prefers a plugin's installed version over the one its meta claims, and falls back to meta", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-builds-telemetry-"))
    try {
      mkdirSync(join(root, "node_modules", "eslint-plugin-installed"), { recursive: true })
      writeFileSync(
        join(root, "node_modules", "eslint-plugin-installed", "package.json"),
        JSON.stringify({ version: "2.125.1" }),
      )
      const active = activeConfig({
        plugins: {
          installed: { meta: { name: "eslint-plugin-installed", version: "2.0.0" } },
          absent: { meta: { name: "eslint-plugin-absent-zz", version: "1.2.3" } },
        },
        rules: { "installed/a": "error" },
      })
      const payload = buildTelemetryPayload({ ...run, dir: root }, {}, Option(active))
      expect(payload.versions).toMatchObject({
        "eslint-plugin-installed": "2.125.1",
        "eslint-plugin-absent-zz": "1.2.3",
      })
      expect(payload.enabled).toEqual({ "installed/a": "error" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

type Received = { readonly body: unknown; readonly contentType: string | undefined }

/** A local receiver. `respond` decides the status; `hang` accepts the request and never answers. */
async function receiver(opts: { status?: number; hang?: boolean } = {}): Promise<{
  url: string
  received: Received[]
  close: () => Promise<void>
}> {
  const received: Received[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      received.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
        contentType: req.headers["content-type"],
      })
      if (opts.hang) return
      res.writeHead(opts.status ?? 204).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1/lint`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const samplePayload = (): TelemetryPayload =>
  buildTelemetryPayload(
    {
      results: [result({ messages: [message("no-var", 2)] })],
      fix: false,
      durationMs: 1,
      packageName: Option("@fixture/pkg"),
      eslintVersion: "10.0.0",
      dir: tmpdir(),
    },
    {},
  )

describe("sendTelemetry", () => {
  it("POSTs the payload as JSON and reports success", async () => {
    const server = await receiver()
    try {
      const payload = samplePayload()
      expect(await sendTelemetry(payload, server.url)).toBe(true)
      expect(server.received).toEqual([{ body: payload, contentType: "application/json" }])
    } finally {
      await server.close()
    }
  })

  it("reports failure, without throwing, on a non-2xx answer", async () => {
    const server = await receiver({ status: 500 })
    try {
      expect(await sendTelemetry(samplePayload(), server.url)).toBe(false)
    } finally {
      await server.close()
    }
  })

  it("gives up at the timeout when the receiver never answers", async () => {
    const server = await receiver({ hang: true })
    try {
      const started = performance.now()
      expect(await sendTelemetry(samplePayload(), server.url, 200)).toBe(false)
      expect(performance.now() - started).toBeLessThan(1500)
    } finally {
      await server.close()
    }
  })

  it("reports failure, without throwing, when nothing is listening", async () => {
    const server = await receiver()
    const { url } = server
    await server.close()
    expect(await sendTelemetry(samplePayload(), url)).toBe(false)
  })
})

describe("reportLintTelemetry", () => {
  const run = {
    results: [result({ messages: [message("no-var", 2)] })],
    fix: false,
    durationMs: 1,
    packageName: Option("@fixture/pkg"),
    eslintVersion: "10.0.0",
    dir: tmpdir(),
  }

  it("does nothing and logs nothing when telemetry is off", async () => {
    const lines: string[] = []
    await reportLintTelemetry(run, {}, (line) => lines.push(line))
    expect(lines).toEqual([])
  })

  it("logs one warning when it's on without a URL", async () => {
    const lines: string[] = []
    await reportLintTelemetry(run, { TS_BUILDS_TELEMETRY: "1" }, (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("TS_BUILDS_TELEMETRY_URL")
  })

  it("prints the payload in debug mode and sends nothing", async () => {
    const server = await receiver()
    try {
      const lines: string[] = []
      await reportLintTelemetry(
        run,
        { TS_BUILDS_TELEMETRY_DEBUG: "1", TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: server.url },
        (line) => lines.push(line),
      )
      expect(server.received).toEqual([])
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
        package: "@fixture/pkg",
        rules: { "no-var": { errors: 1 } },
      })
    } finally {
      await server.close()
    }
  })

  it("sends when it's on with a URL", async () => {
    const server = await receiver()
    try {
      await reportLintTelemetry(run, { TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: server.url }, () => undefined)
      expect(server.received).toHaveLength(1)
      expect(server.received[0]?.body).toMatchObject({ package: "@fixture/pkg" })
    } finally {
      await server.close()
    }
  })
})

const withId = (ruleId: string, severity: 1 | 2, messageId: string, line = 1): Linter.LintMessage =>
  ({ ...message(ruleId, severity), messageId, line }) as Linter.LintMessage

const silencedWithId = (ruleId: string, messageId: string, line = 1): Linter.SuppressedLintMessage =>
  ({
    ...withId(ruleId, 2, messageId, line),
    suppressions: [{ kind: "directive", justification: "" }],
  }) as Linter.SuppressedLintMessage

describe("messageStats", () => {
  it("splits each rule's counts by message id, sorted", () => {
    const stats = messageStats([
      result({
        messages: [withId("x/b", 1, "two"), withId("x/b", 2, "one"), withId("x/a", 1, "only"), message("x/a", 1)],
        suppressedMessages: [silencedWithId("x/b", "one")],
      }),
    ])
    expect(stats).toEqual({
      "x/a": { only: { errors: 0, warnings: 1, silenced: 0 } },
      "x/b": { one: { errors: 1, warnings: 0, silenced: 1 }, two: { errors: 0, warnings: 1, silenced: 0 } },
    })
    expect(Object.keys(stats)).toEqual(["x/a", "x/b"])
  })

  it("counts ids named like Object prototype members, and leaves out ids that aren't identifiers", () => {
    const stats = messageStats([
      result({
        messages: [
          withId("x/a", 1, "constructor"),
          withId("x/a", 1, "toString"),
          withId("x/a", 1, "has space: /Users/x"),
        ],
      }),
    ])
    expect(stats).toEqual({
      "x/a": {
        constructor: { errors: 0, warnings: 1, silenced: 0 },
        toString: { errors: 0, warnings: 1, silenced: 0 },
      },
    })
  })

  it("is empty when no finding has a message id", () => {
    expect(messageStats([result({ messages: [message("no-var", 2)] })])).toEqual({})
  })
})

describe("traceCandidates", () => {
  it("makes paths relative to the root, sorts them, and leaves out files outside it", () => {
    const root = join(tmpdir(), "repo")
    const found = traceCandidates(
      [
        result({ filePath: join(root, "src", "b.ts"), messages: [withId("x/a", 1, "m", 9)] }),
        result({ filePath: join(root, "src", "a.ts"), suppressedMessages: [silencedWithId("x/a", "m", 3)] }),
        result({ filePath: join(tmpdir(), "elsewhere.ts"), messages: [message("x/a", 2)] }),
      ],
      root,
    )
    expect(found).toEqual([
      { rule: "x/a", message: "m", kind: "silenced", file: "src/a.ts", line: 3 },
      { rule: "x/a", message: "m", kind: "warning", file: "src/b.ts", line: 9 },
    ])
  })

  it("keeps a directory whose name starts with two dots", () => {
    const root = join(tmpdir(), "repo")
    const found = traceCandidates(
      [result({ filePath: join(root, "..cache", "a.ts"), messages: [message("x/a", 1)] })],
      root,
    )
    expect(found.map((f) => f.file)).toEqual(["..cache/a.ts"])
  })
})

describe("isTraceRepo", () => {
  it("accepts host/owner/repo with a domain host", () => {
    expect(isTraceRepo("github.com/owner/repo")).toBe(true)
    expect(isTraceRepo("gitlab.example.com/group/sub/repo")).toBe(true)
  })

  it("rejects path remotes and dot segments", () => {
    for (const repo of [
      "../mirrors/team/repo",
      "./a/b/c",
      "repos/a/b",
      "/srv/git/x",
      "github.com/x/..",
      "github.com/./.",
    ])
      expect(isTraceRepo(repo)).toBe(false)
  })
})

describe("traceOn", () => {
  it("needs TS_BUILDS_TELEMETRY_TRACE", () => {
    expect(traceOn({})).toBe(false)
    expect(traceOn({ TS_BUILDS_TELEMETRY_TRACE: "1" })).toBe(true)
  })
})

describe("gitTrace", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const repo = (remote: string): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ts-builds-trace-")))
    roots.push(root)
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" })
    }
    run("init", "-q")
    run("config", "user.email", "test@example.com")
    run("config", "user.name", "test")
    run("config", "commit.gpgsign", "false")
    run("remote", "add", "origin", remote)
    mkdirSync(join(root, "pkg", "src"), { recursive: true })
    for (const file of ["clean.ts", "edited.ts", "[slug].ts"]) writeFileSync(join(root, "pkg", "src", file), "x\n")
    run("add", ".")
    run("commit", "-q", "-m", "init")
    writeFileSync(join(root, "pkg", "src", "edited.ts"), "changed\n")
    writeFileSync(join(root, "pkg", "src", "new.ts"), "x\n")
    return root
  }

  const finding = (root: string, file: string): ESLint.LintResult =>
    result({ filePath: join(root, "pkg", "src", file), messages: [withId("x/a", 1, "m", 1)] })

  it("traces findings in committed, unchanged files, with the repo and HEAD", () => {
    const root = repo("git@github.com:Owner/Repo.git")
    const results = ["clean.ts", "edited.ts", "new.ts", "[slug].ts"].map((f) => finding(root, f))
    const trace = gitTrace(results, join(root, "pkg")).orThrow(new Error("no trace"))
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim()
    expect(trace.repo).toBe("github.com/owner/repo")
    expect(trace.commit).toBe(head)
    expect(trace.findings.map((f) => f.file)).toEqual(["pkg/src/[slug].ts", "pkg/src/clean.ts"])
    expect(trace.dropped).toBe(2)
    expect(JSON.stringify(trace)).not.toContain(root)
  })

  it("caps findings and counts the rest as dropped", () => {
    const root = repo("https://github.com/a/b")
    const many = result({
      filePath: join(root, "pkg", "src", "clean.ts"),
      messages: Array.from({ length: MAX_TRACE_FINDINGS + 5 }, (_, i) => withId("x/a", 1, "m", i + 1)),
    })
    const trace = gitTrace([many], root).orThrow(new Error("no trace"))
    expect(trace.findings).toHaveLength(MAX_TRACE_FINDINGS)
    expect(trace.dropped).toBe(5)
  })

  it("gives no trace for a remote that isn't host/owner/repo", () => {
    const root = repo("/srv/git/local-only")
    expect(gitTrace([finding(root, "clean.ts")], root).isEmpty).toBe(true)
  })

  it("gives no trace for a relative-path remote", () => {
    const root = repo("../mirrors/team/repo.git")
    expect(gitTrace([finding(root, "clean.ts")], root).isEmpty).toBe(true)
  })

  it.skipIf(process.platform === "win32")("drops every finding when git can't say what changed", () => {
    const root = repo("https://github.com/a/b")
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim()
    const shim = realpathSync(mkdtempSync(join(tmpdir(), "ts-builds-gitshim-")))
    roots.push(shim)
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = diff ] && exit 128; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    )
    const path = process.env.PATH
    process.env.PATH = `${shim}:${path ?? ""}`
    try {
      const trace = gitTrace([finding(root, "clean.ts"), finding(root, "edited.ts")], root).orThrow(
        new Error("no trace"),
      )
      expect(trace.findings).toEqual([])
      expect(trace.dropped).toBe(2)
    } finally {
      process.env.PATH = path
    }
  })

  it("gives no trace outside a git repo", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ts-builds-nogit-")))
    roots.push(dir)
    expect(gitTrace([], dir).isEmpty).toBe(true)
  })

  it("is only in the payload with TS_BUILDS_TELEMETRY_TRACE", () => {
    const root = repo("https://github.com/a/b")
    const run = {
      results: [finding(root, "clean.ts")],
      fix: false,
      durationMs: 1,
      packageName: Option("pkg"),
      eslintVersion: "10.0.0",
      dir: root,
    }
    const plain = buildTelemetryPayload(run, {})
    expect(plain).not.toHaveProperty("trace")
    expect(JSON.stringify(plain)).not.toContain("clean.ts")
    expect(plain.messages).toEqual({ "x/a": { m: { errors: 0, warnings: 1, silenced: 0 } } })
    const traced = buildTelemetryPayload(run, { TS_BUILDS_TELEMETRY_TRACE: "1" })
    expect(traced.trace?.findings).toEqual([
      { rule: "x/a", message: "m", kind: "warning", file: "pkg/src/clean.ts", line: 1 },
    ])
  })
})

describe("fitTrace", () => {
  const payload: TelemetryPayload = {
    schema: 1,
    ci: true,
    fix: false,
    durationMs: 1,
    files: 1,
    fatal: 0,
    versions: {},
    rules: {},
  }
  const findings = Array.from({ length: 200 }, (_, i) => ({
    rule: "functype/prefer-option",
    message: "preferOption",
    kind: "warning" as const,
    file: `packages/some/deeply/nested/directory/structure/file-${i}.ts`,
    line: i + 1,
  }))
  const trace = { repo: "github.com/a/b", commit: "a".repeat(40), findings, dropped: 3 }

  it("keeps every finding when they fit", () => {
    expect(fitTrace(payload, trace, 1_000_000)).toEqual(trace)
  })

  it("keeps findings in order until the payload would pass the cap, and counts the rest", () => {
    const fitted = fitTrace(payload, trace, 5_000)
    expect(fitted.findings.length).toBeGreaterThan(0)
    expect(fitted.findings.length).toBeLessThan(200)
    expect(fitted.findings).toEqual(findings.slice(0, fitted.findings.length))
    expect(fitted.dropped).toBe(3 + 200 - fitted.findings.length)
    expect(Buffer.byteLength(JSON.stringify({ ...payload, trace: fitted }))).toBeLessThanOrEqual(5_000)
  })

  it("sends no findings, but still the counts, when the payload alone is near the cap", () => {
    const fitted = fitTrace(payload, trace, 100)
    expect(fitted.findings).toEqual([])
    expect(fitted.dropped).toBe(203)
  })
})
