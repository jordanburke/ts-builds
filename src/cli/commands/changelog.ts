import { join } from "node:path"

import { List, Option } from "functype"
import { Fs, Process } from "functype-os"

import type { ChangelogConfig } from "../config"
import { loadConfig, targetDir } from "../config"

interface RawCommit {
  hash: string
  subject: string
  body: string
  author: string
  date: string
}

interface ParsedCommit {
  hash: string
  type: string
  scope: Option<string>
  breaking: boolean
  description: string
  author: string
  date: string
  issues: List<string>
}

interface GroupedChangelog {
  breaking: List<ParsedCommit>
  sections: List<{ title: string; commits: List<ParsedCommit> }>
}

const defaultTypeMap: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests",
  ci: "CI/CD",
  build: "Build",
  style: "Style",
  chore: "Chores",
}

const defaultExclude = List(["chore"])

function execGit(args: string): Option<string> {
  return Process.execSync(`git ${args}`, { cwd: targetDir }).fold(
    () => Option.none<string>(),
    (result) => {
      const trimmed = result.stdout.trim()
      return trimmed ? Option(trimmed) : Option.none<string>()
    },
  )
}

export function getLastTag(): Option<string> {
  return execGit("describe --tags --abbrev=0")
}

export function getCommitsSince(since: Option<string>): List<RawCommit> {
  const delimiter = "---COMMIT---"
  const fieldSep = "|||"
  const format = `${delimiter}%H${fieldSep}%s${fieldSep}%b${fieldSep}%an${fieldSep}%aI`
  const range = since.fold(
    () => "HEAD",
    (tag) => `${tag}..HEAD`,
  )

  return execGit(`log ${range} --format="${format}"`).fold(
    () => List.empty<RawCommit>(),
    (output) =>
      List(output.split(delimiter))
        .filter((s) => s.trim().length > 0)
        .map((entry) => {
          const parts = entry.split(fieldSep)
          return {
            hash: (parts[0] ?? "").trim(),
            subject: (parts[1] ?? "").trim(),
            body: (parts[2] ?? "").trim(),
            author: (parts[3] ?? "").trim(),
            date: (parts[4] ?? "").trim(),
          }
        })
        .filter((c) => c.hash.length > 0 && c.subject.length > 0),
  )
}

export function parseConventionalCommit(
  subject: string,
): { type: string; scope: Option<string>; breaking: boolean; description: string } | null {
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/)
  if (!match) return null

  return {
    type: match[1],
    scope: Option(match[2]),
    breaking: match[3] === "!",
    description: match[4],
  }
}

export function extractIssueRefs(text: string): List<string> {
  const matches = text.match(/#(\d+)/g)
  return matches ? List(matches.map((m) => m.slice(1))) : List.empty()
}

function getRepoUrl(): Option<string> {
  const packageJsonPath = join(targetDir, "package.json")

  return Fs.readFileSync(packageJsonPath)
    .toOption()
    .flatMap((content) => {
      const pkg = JSON.parse(content)
      const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url
      return Option(repoUrl as string | undefined)
    })
    .map((url) =>
      url
        .replace(/^git\+/, "")
        .replace(/\.git$/, "")
        .replace(/^git:\/\//, "https://"),
    )
}

function groupCommits(
  commits: List<ParsedCommit>,
  typeMap: Record<string, string>,
  exclude: List<string>,
): GroupedChangelog {
  const filtered = commits.filter((c) => !exclude.contains(c.type))
  const breaking = filtered.filter((c) => c.breaking)

  const byType = filtered.filter((c) => typeMap[c.type] !== undefined).groupBy((c) => typeMap[c.type])

  const sectionOrder = List([...new Set(Object.values(typeMap))])
  const sections = sectionOrder
    .filter((title) => byType.has(title))
    .map((title) => ({ title, commits: byType.get(title) ?? List.empty<ParsedCommit>() }))

  return { breaking, sections }
}

function formatCommitLine(commit: ParsedCommit, repoUrl: Option<string>): string {
  const shortHash = commit.hash.slice(0, 7)
  const scope = commit.scope.fold(
    () => "",
    (s) => `**${s}**: `,
  )
  const hashLink = repoUrl.fold(
    () => `(${shortHash})`,
    (url) => `([${shortHash}](${url}/commit/${commit.hash}))`,
  )
  const issueLinks = commit.issues
    .map((num) =>
      repoUrl.fold(
        () => `#${num}`,
        (url) => `[#${num}](${url}/issues/${num})`,
      ),
    )
    .toArray()
    .join(", ")
  const issueRef = issueLinks ? ` ${issueLinks}` : ""

  return `- ${scope}${commit.description} ${hashLink}${issueRef}`
}

function formatMarkdown(grouped: GroupedChangelog, repoUrl: Option<string>, version: Option<string>): string {
  const lines: string[] = []
  const date = new Date().toISOString().split("T")[0]

  lines.push(
    version.fold(
      () => `## Unreleased (${date})`,
      (v) => `## ${v} (${date})`,
    ),
  )
  lines.push("")

  if (grouped.breaking.nonEmpty) {
    lines.push("### BREAKING CHANGES")
    lines.push("")
    for (const commit of grouped.breaking) {
      lines.push(formatCommitLine(commit, repoUrl))
    }
    lines.push("")
  }

  for (const section of grouped.sections) {
    lines.push(`### ${section.title}`)
    lines.push("")
    for (const commit of section.commits) {
      lines.push(formatCommitLine(commit, repoUrl))
    }
    lines.push("")
  }

  return lines.join("\n")
}

export async function runChangelog(args: string[]): Promise<number> {
  const config = loadConfig()
  const changelogConfig: ChangelogConfig = config.changelog

  const typeMap = { ...defaultTypeMap, ...changelogConfig.types }
  const exclude = changelogConfig.exclude ? List(changelogConfig.exclude) : defaultExclude

  let since: Option<string> = Option.none()
  let output: Option<string> = Option.none()
  let version: Option<string> = Option.none()
  let sinceExplicit = false

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--since":
        since = Option(args[++i])
        sinceExplicit = true
        break
      case "--output":
        output = Option(args[++i])
        break
      case "--version":
        version = Option(args[++i])
        break
    }
  }

  if (!sinceExplicit) {
    since = getLastTag()
  }

  const rawCommits = getCommitsSince(since)

  if (rawCommits.isEmpty) {
    console.log(
      since.fold(
        () => "No commits found",
        (tag) => `No commits found since ${tag}`,
      ),
    )
    return 0
  }

  const repoUrl = getRepoUrl()

  const parsed = rawCommits
    .map((raw) => {
      const conv = parseConventionalCommit(raw.subject)
      if (!conv) return null

      const bodyBreaking = raw.body.includes("BREAKING CHANGE")
      const issues = extractIssueRefs(raw.subject).concat(extractIssueRefs(raw.body)).distinct()

      return {
        hash: raw.hash,
        type: conv.type,
        scope: conv.scope,
        breaking: conv.breaking || bodyBreaking,
        description: conv.description,
        author: raw.author,
        date: raw.date,
        issues,
      } satisfies ParsedCommit
    })
    .filter((c): c is ParsedCommit => c !== null)

  if (parsed.isEmpty) {
    console.log("No conventional commits found")
    return 0
  }

  const grouped = groupCommits(parsed, typeMap, exclude)
  const markdown = formatMarkdown(grouped, repoUrl, version)

  output.fold(
    () => console.log(markdown),
    (file) => {
      const outputPath = join(targetDir, file)
      Fs.writeFileSync(outputPath, markdown)
      console.log(`Changelog written to ${file}`)
    },
  )

  return 0
}
