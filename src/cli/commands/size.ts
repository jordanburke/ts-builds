import { join, relative } from "node:path"
import { gzipSync } from "node:zlib"

import type { Either } from "functype"
import { $, Do, List, Option } from "functype"
import { Fs } from "functype-os"

import { loadConfig, targetDir } from "../config"

interface FileSize {
  path: string
  raw: number
  gzip: number
}

interface SizeEntry {
  raw: number
  gzip: number
}

interface SizeBaseline {
  timestamp: string
  total: SizeEntry
  files: Record<string, SizeEntry>
}

function measureEntry(dir: string, entry: string, absDir: string): List<FileSize> {
  const fullPath = join(absDir, entry)

  const result = Do(function* () {
    const info = yield* $(Fs.statSync(fullPath))
    if (info.isDirectory) return getFileSizes(join(dir, entry))
    const content = yield* $(Fs.readFileSync(fullPath))
    const buf = Buffer.from(content)
    return List([
      {
        path: relative(targetDir, fullPath),
        raw: info.size,
        gzip: gzipSync(buf).length,
      },
    ])
  }) as Either<unknown, List<FileSize>>

  return result.fold(
    () => List.empty(),
    (list) => list,
  )
}

function getFileSizes(dir: string): List<FileSize> {
  const absDir = join(targetDir, dir)
  if (!Fs.existsSync(absDir)) return List.empty()

  return Fs.readdirSync(absDir).fold(
    () => List.empty<FileSize>(),
    (entries) => entries.flatMap((entry) => measureEntry(dir, entry, absDir)),
  )
}

function loadBaseline(baselinePath: string): Option<SizeBaseline> {
  const absPath = join(targetDir, baselinePath)
  return Fs.readFileSync(absPath)
    .toOption()
    .flatMap((content) => {
      try {
        return Option(JSON.parse(content) as SizeBaseline)
      } catch {
        return Option.none<SizeBaseline>()
      }
    })
}

function saveBaseline(baselinePath: string, files: List<FileSize>): void {
  const absPath = join(targetDir, baselinePath)
  const totalRaw = files.fold(0, (sum, f) => sum + f.raw)
  const totalGzip = files.fold(0, (sum, f) => sum + f.gzip)

  const baseline: SizeBaseline = {
    timestamp: new Date().toISOString(),
    total: { raw: totalRaw, gzip: totalGzip },
    files: Object.fromEntries(files.map((f) => [f.path, { raw: f.raw, gzip: f.gzip }] as const).toArray()),
  }

  Fs.writeFileSync(absPath, JSON.stringify(baseline, null, 2) + "\n")
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb < 1024 ? `${kb.toFixed(2)} kB` : `${(kb / 1024).toFixed(2)} MB`
}

function formatDelta(current: number, previous: number): string {
  const diff = current - previous
  if (diff === 0) return ""
  const sign = diff > 0 ? "+" : ""
  return ` (${sign}${formatBytes(diff)})`
}

function formatSizeTable(files: List<FileSize>, baseline: Option<SizeBaseline>, showGzip: boolean): string {
  const lines: string[] = []

  const nameWidth = Math.max(4, ...files.map((f) => f.path.length).toArray())
  const sizeWidth = 10
  const gzipWidth = 10
  const deltaWidth = 16

  const header = showGzip
    ? `${"File".padEnd(nameWidth)}  ${"Size".padStart(sizeWidth)}  ${"Gzip".padStart(gzipWidth)}  ${"Delta".padStart(deltaWidth)}`
    : `${"File".padEnd(nameWidth)}  ${"Size".padStart(sizeWidth)}  ${"Delta".padStart(deltaWidth)}`

  lines.push(header)
  lines.push("-".repeat(header.length))

  const baselineData = baseline.orUndefined()

  for (const file of files) {
    const prev = baselineData?.files[file.path]
    const delta = prev ? formatDelta(file.raw, prev.raw) : ""
    const row = showGzip
      ? `${file.path.padEnd(nameWidth)}  ${formatBytes(file.raw).padStart(sizeWidth)}  ${formatBytes(file.gzip).padStart(gzipWidth)}  ${delta.padStart(deltaWidth)}`
      : `${file.path.padEnd(nameWidth)}  ${formatBytes(file.raw).padStart(sizeWidth)}  ${delta.padStart(deltaWidth)}`
    lines.push(row)
  }

  const totalRaw = files.fold(0, (sum, f) => sum + f.raw)
  const totalGzip = files.fold(0, (sum, f) => sum + f.gzip)
  const totalDelta = baselineData ? formatDelta(totalRaw, baselineData.total.raw) : ""

  lines.push("-".repeat(header.length))
  const totalRow = showGzip
    ? `${"Total".padEnd(nameWidth)}  ${formatBytes(totalRaw).padStart(sizeWidth)}  ${formatBytes(totalGzip).padStart(gzipWidth)}  ${totalDelta.padStart(deltaWidth)}`
    : `${"Total".padEnd(nameWidth)}  ${formatBytes(totalRaw).padStart(sizeWidth)}  ${totalDelta.padStart(deltaWidth)}`
  lines.push(totalRow)

  return lines.join("\n")
}

export async function runSize(args: string[]): Promise<number> {
  const config = loadConfig()
  const sizeConfig = config.size
  const showGzip = sizeConfig.gzip !== false
  const baselineFile = sizeConfig.baselineFile ?? ".ts-builds-size.json"
  const save = args.includes("--save")

  const files = getFileSizes("dist").sorted((a, b) => b.raw - a.raw)

  if (files.isEmpty) {
    console.error("No files found in dist/. Run a build first.")
    return 1
  }

  const baseline = loadBaseline(baselineFile)
  const table = formatSizeTable(files, baseline, showGzip)

  console.log("\nBundle Size Report\n")
  console.log(table)

  baseline.map((b) => {
    console.log(`\nBaseline: ${b.timestamp}`)
    return b
  })

  if (save) {
    saveBaseline(baselineFile, files)
    console.log(`\nBaseline saved to ${baselineFile}`)
  }

  const totalRaw = files.fold(0, (sum, f) => sum + f.raw)
  let failed = false

  if (sizeConfig.maxTotal && totalRaw > sizeConfig.maxTotal) {
    console.error(`\nTotal size ${formatBytes(totalRaw)} exceeds max ${formatBytes(sizeConfig.maxTotal)}`)
    failed = true
  }

  if (sizeConfig.maxFile) {
    for (const file of files) {
      if (file.raw > sizeConfig.maxFile) {
        console.error(
          `\n${file.path} (${formatBytes(file.raw)}) exceeds max file size ${formatBytes(sizeConfig.maxFile)}`,
        )
        failed = true
      }
    }
  }

  return failed ? 1 : 0
}
