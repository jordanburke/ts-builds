import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  depcruiseFixture,
  describeDepcruise,
  describeFinding,
  EXPECTED,
  EXPECTED_DEPCRUISE,
  lintFixture,
} from "./architecture-expected"

/**
 * The in-repo fixture can't prove how ts-builds resolves its own dependencies: Node
 * walks up from the fixture into this repo's node_modules, which has everything. So
 * this spec packs ts-builds, installs the tarball into a copy of the fixture outside
 * the repo, hoists only what a consumer's config imports by name, and expects the
 * same findings. It doesn't touch the in-repo fixture's install, so it runs on its own.
 * Runs after the build, as validate:bootstrap does.
 */
const repo = process.cwd()
const fixture = join(repo, "test", "fixtures", "architecture")

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf-8" })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

describe("architecture boundaries from a packed install", () => {
  let scratch = ""
  let consumer = ""

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "ts-builds-packed-"))
    run("pnpm", ["pack", "--pack-destination", scratch], repo)
    const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"))
    if (tarball === undefined) throw new Error("pnpm pack wrote no tarball")

    consumer = join(scratch, "consumer")
    cpSync(fixture, consumer, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.endsWith("pnpm-lock.yaml"),
    })
    const pkg = JSON.parse(readFileSync(join(consumer, "package.json"), "utf-8")) as Record<string, unknown>
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify(
        {
          ...pkg,
          devDependencies: {
            ...(pkg.devDependencies as Record<string, string>),
            "ts-builds": `file:${join(scratch, tarball)}`,
          },
        },
        null,
        2,
      ),
    )
    // Hoist only the two packages the consumer's own files import by name. The
    // resolver and the plugin must load from ts-builds' dependencies.
    writeFileSync(
      join(consumer, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n  - 'apps/*'\npublicHoistPattern:\n  - 'eslint'\n  - 'typescript-eslint'\n",
    )
    run("pnpm", ["install", "--prefer-offline"], consumer)
  }, 180_000)

  afterAll(() => {
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true })
  })

  it.each(["eslint-import-resolver-typescript", "dependency-cruiser"])(
    "leaves %s out of the consumer's reach, so ts-builds must load it",
    (name) => {
      const check = spawnSync(process.execPath, ["-e", `require.resolve(${JSON.stringify(name)})`], { cwd: consumer })
      expect(check.status).not.toBe(0)
    },
  )

  it("reports exactly the seeded violations, as the in-repo fixture does", () => {
    expect(lintFixture(consumer, ".").map(describeFinding)).toEqual(EXPECTED)
  }, 60_000)

  it.each([".", "packages/rules"])(
    "runs dependency-cruiser from %s with the same findings",
    (cwd) => {
      const run = depcruiseFixture(consumer, cwd)
      expect(run.exitCode).toBe(1)
      expect(run.violations.map(describeDepcruise)).toEqual(EXPECTED_DEPCRUISE)
    },
    60_000,
  )

  it("runs the installed ts-builds depcruise command from a workspace", () => {
    const run = spawnSync(
      process.execPath,
      [join(consumer, "node_modules", "ts-builds", "dist", "cli.js"), "depcruise"],
      {
        cwd: join(consumer, "apps", "api"),
        encoding: "utf-8",
      },
    )
    expect(run.stderr).toBe("")
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`✘ ${EXPECTED_DEPCRUISE.length} dependency violations`)
  }, 60_000)
})
