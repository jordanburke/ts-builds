import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  installedVersion,
  isCi,
  normalizeRemote,
  pluginPackage,
  projectId,
  reportLintTelemetry,
  ruleStats,
  sendTelemetry,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryPayload,
  telemetryMode,
} from "../src/cli/telemetry"

const message = (ruleId: string | null, severity: 1 | 2, text = "a message"): Linter.LintMessage =>
  ({ ruleId, severity, message: text, line: 1, column: 1 }) as Linter.LintMessage

const suppressed = (ruleId: string | null, kind: "directive" | "external"): Linter.SuppressedLintMessage =>
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
  it("counts errors, warnings, silenced and baselined findings per rule", () => {
    const stats = ruleStats([
      result({
        messages: [message("functype/prefer-option", 2), message("functype/prefer-option", 1), message("no-var", 2)],
        suppressedMessages: [
          suppressed("functype/prefer-option", "directive"),
          suppressed("functype/prefer-option", "external"),
        ],
      }),
      result({ messages: [message("functype/prefer-option", 2)] }),
    ])
    expect(stats.rules).toEqual({
      "functype/prefer-option": { errors: 2, warnings: 1, silenced: 1, baselined: 1 },
      "no-var": { errors: 1, warnings: 0, silenced: 0, baselined: 0 },
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
    pkg: "@fixture/pkg",
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
      rules: { "no-var": { errors: 1, warnings: 0, silenced: 0, baselined: 0 } },
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
      pkg: "@fixture/pkg",
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
    pkg: "@fixture/pkg",
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
