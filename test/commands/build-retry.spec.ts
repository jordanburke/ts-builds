import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock node:fs/promises so we can drive `rm` failure modes deterministically.
// Real EBUSY/EPERM scenarios are hard to provoke on macOS/Linux test runners.
const rmMock = vi.fn()
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return { ...actual, rm: rmMock }
})

// Import AFTER mocking so cleanDir picks up the mocked rm.
const { cleanDir } = await import("../../src/cli/commands/build")

class FsError extends Error {
  code: string
  constructor(code: string, message: string = code) {
    super(message)
    this.code = code
  }
}

beforeEach(() => {
  rmMock.mockReset()
})

describe("cleanDir retry behavior", () => {
  it("succeeds on first attempt when rm resolves cleanly", async () => {
    rmMock.mockResolvedValueOnce(undefined)
    const code = await cleanDir("/fake/path")
    expect(code).toBe(0)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it("retries on EBUSY and succeeds on a later attempt", async () => {
    rmMock
      .mockRejectedValueOnce(new FsError("EBUSY"))
      .mockRejectedValueOnce(new FsError("EBUSY"))
      .mockResolvedValueOnce(undefined)
    const code = await cleanDir("/fake/path")
    expect(code).toBe(0)
    expect(rmMock).toHaveBeenCalledTimes(3)
  })

  it("retries on each documented transient error code", async () => {
    // One run per code: first attempt fails with the code, second succeeds.
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE"]) {
      rmMock.mockReset()
      rmMock.mockRejectedValueOnce(new FsError(code)).mockResolvedValueOnce(undefined)
      const exit = await cleanDir(`/fake/${code}`)
      expect(exit, `transient code ${code} should be retried`).toBe(0)
      expect(rmMock, `transient code ${code} should retry exactly once`).toHaveBeenCalledTimes(2)
    }
  })

  it("fails immediately (no retry) on a non-transient error code", async () => {
    // EACCES is a permission error that won't fix itself by waiting.
    rmMock.mockRejectedValueOnce(new FsError("EACCES", "permission denied"))
    const code = await cleanDir("/fake/path")
    expect(code).toBe(1)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it("treats unknown error codes as non-transient (no infinite retry)", async () => {
    rmMock.mockRejectedValueOnce(new FsError("ENOSPC", "no space"))
    const code = await cleanDir("/fake/path")
    expect(code).toBe(1)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it("treats errors without a code as non-transient", async () => {
    rmMock.mockRejectedValueOnce(new Error("mystery failure"))
    const code = await cleanDir("/fake/path")
    expect(code).toBe(1)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it("fails after exhausting all retries on persistent EBUSY", async () => {
    rmMock.mockRejectedValue(new FsError("EBUSY"))
    const code = await cleanDir("/fake/path")
    expect(code).toBe(1)
    // 1 initial attempt + 4 retry delays = 5 total attempts
    expect(rmMock).toHaveBeenCalledTimes(5)
  }, 10_000)
})
