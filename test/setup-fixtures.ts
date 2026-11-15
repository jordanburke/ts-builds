import { spawnSync } from "node:child_process"
import { join } from "node:path"

/**
 * Installs the architecture fixture once, before any spec runs. Specs used to install it in
 * their own hooks, and Vitest runs spec files in parallel, so a second install's temporary
 * files raced the packed-install spec copying the fixture. A failed install throws, which
 * fails the whole run: the fixture is the only proof the pinned plugin, resolver and
 * dependency-cruiser still behave, so it must never be skipped.
 */
export default function setup(): void {
  const fixture = join(process.cwd(), "test", "fixtures", "architecture")
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
    cwd: fixture,
    encoding: "utf-8",
  })
  if (install.status !== 0) {
    throw new Error(`pnpm install in test/fixtures/architecture failed:\n${install.stdout}\n${install.stderr}`)
  }
}
