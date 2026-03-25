import { join } from "node:path"
import { execSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const cliPath = join(process.cwd(), "dist/cli.js")

describe("ts-builds doctor", () => {
  it("should run health check on current project", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("ts-builds doctor")
    expect(output).toContain("Summary:")
  })

  it("should check required fields", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("Required fields")
    expect(output).toContain("name: ts-builds")
    expect(output).toContain("version:")
    expect(output).toContain("license: MIT")
  })

  it("should check exports", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("Exports")
    expect(output).toContain("./eslint")
    expect(output).toContain("./prettier")
  })

  it("should check entry points", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("Entry points")
    expect(output).toContain("bin.ts-builds")
  })

  it("should check files field", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("Files")
    expect(output).toContain("dist/")
  })

  it("should check peer dependencies", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("Peer dependencies")
    expect(output).toContain("tsdown")
  })

  it("should report no errors for ts-builds itself", () => {
    const output = execSync(`node ${cliPath} doctor`, { encoding: "utf-8" })
    expect(output).toContain("0 error(s)")
  })
})
