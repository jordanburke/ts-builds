import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { LintReport } from "../../src/cli/lint-report"
import { TELEMETRY_TIMEOUT_MS } from "../../src/cli/telemetry"

/**
 * Telemetry through the built CLI, end to end: what a real `ts-builds lint:check` run prints and
 * sends. The CLI runs in a child process, spawned asynchronously so this process's receiver can
 * answer it. Skipped (not failed) when `dist/cli.js` is absent, as in run-lint.spec.ts.
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
const cliPath = join(repoRoot, "dist", "cli.js")
const itIfBuilt = it.skipIf(!existsSync(cliPath))

/** The parent's env, minus anything that would turn telemetry on or name an agent. */
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("TS_BUILDS_TELEMETRY") && key !== "DO_NOT_TRACK" && key !== "CLAUDECODE",
    ),
  )

/** One error, one finding silenced by a directive, in a package that isn't a git repo. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-builds-lint-telemetry-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@fixture/telemetry", type: "module" }))
  writeFileSync(join(dir, "eslint.config.js"), 'export default [{ rules: { "no-unused-vars": "error" } }]')
  mkdirSync(join(dir, "src"))
  writeFileSync(
    join(dir, "src", "a.js"),
    "const unused = 1\n// eslint-disable-next-line no-unused-vars\nconst hidden = 2\nexport default 3\n",
  )
  return dir
}

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string; readonly ms: number }

function runCli(cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  const started = performance.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "lint:check"], { cwd, env })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => out.push(c))
    child.stderr.on("data", (c: Buffer) => err.push(c))
    child.on("close", (code) =>
      resolve({
        status: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        ms: performance.now() - started,
      }),
    )
  })
}

async function receiver(hang = false): Promise<{ url: string; bodies: unknown[]; close: () => Promise<void> }> {
  const bodies: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")))
      if (!hang) res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1/lint`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function withFixture(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeFixture()
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const EXPECTED_RULES = { "no-unused-vars": { errors: 1, warnings: 0, silenced: 1, baselined: 0 } }

describe("lint telemetry (via built CLI)", () => {
  itIfBuilt("is silent when off, and the sidecar still records per-rule counts", async () => {
    await withFixture(async (dir) => {
      const run = await runCli(dir, cleanEnv())
      expect(run.status).toBe(1)
      expect(run.stderr).not.toContain("[ts-builds telemetry]")
      const report = JSON.parse(readFileSync(join(dir, ".ts-builds", "lint-report.json"), "utf-8")) as LintReport
      expect(report.rules).toEqual(EXPECTED_RULES)
    })
  })

  itIfBuilt("prints the payload to stderr in debug mode, leaving stdout and the exit code alone", async () => {
    await withFixture(async (dir) => {
      const run = await runCli(dir, { ...cleanEnv(), TS_BUILDS_TELEMETRY_DEBUG: "1" })
      expect(run.status).toBe(1)
      expect(run.stdout).toContain("no-unused-vars")
      expect(run.stdout).not.toContain("[ts-builds telemetry]")
      const json = run.stderr.slice(run.stderr.indexOf("{"))
      const payload = JSON.parse(json) as Record<string, unknown>
      expect(payload).toMatchObject({ package: "@fixture/telemetry", fix: false, files: 1, rules: EXPECTED_RULES })
      expect(payload).not.toHaveProperty("project") // not a git repo
      expect(payload.enabled).toEqual({}) // the fixture's config has only a core rule
      expect(json).not.toContain(dir)
    })
  })

  itIfBuilt("sends one payload when on, without changing the exit code", async () => {
    const server = await receiver()
    try {
      await withFixture(async (dir) => {
        const run = await runCli(dir, { ...cleanEnv(), TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: server.url })
        expect(run.status).toBe(1)
        expect(run.stderr).toBe("")
        expect(server.bodies).toHaveLength(1)
        expect(server.bodies[0]).toMatchObject({ package: "@fixture/telemetry", rules: EXPECTED_RULES })
      })
    } finally {
      await server.close()
    }
  })

  itIfBuilt("sends nothing when DO_NOT_TRACK is set", async () => {
    const server = await receiver()
    try {
      await withFixture(async (dir) => {
        const env = { ...cleanEnv(), DO_NOT_TRACK: "1", TS_BUILDS_TELEMETRY: "1", TS_BUILDS_TELEMETRY_URL: server.url }
        expect((await runCli(dir, env)).status).toBe(1)
        expect(server.bodies).toEqual([])
      })
    } finally {
      await server.close()
    }
  })

  itIfBuilt(
    "adds at most the timeout when the receiver never answers",
    async () => {
      const server = await receiver(true)
      try {
        await withFixture(async (dir) => {
          const baseline = await runCli(dir, cleanEnv())
          const run = await runCli(dir, {
            ...cleanEnv(),
            TS_BUILDS_TELEMETRY: "1",
            TS_BUILDS_TELEMETRY_URL: server.url,
          })
          expect(run.status).toBe(1)
          expect(server.bodies).toHaveLength(1)
          expect(run.ms - baseline.ms).toBeLessThan(TELEMETRY_TIMEOUT_MS + 1500)
        })
      } finally {
        await server.close()
      }
    },
    20_000,
  )
})
