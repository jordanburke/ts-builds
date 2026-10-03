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

  const sectionOrder = List(Object.values(typeMap)).distinct()
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

function formatSection(title: string, commits: List<ParsedCommit>, repoUrl: Option<string>): string[] {
  return [`### ${title}`, "", ...commits.toArray().map((commit) => formatCommitLine(commit, repoUrl)), ""]
}

function formatMarkdown(grouped: GroupedChangelog, repoUrl: Option<string>, version: Option<string>): string {
  const date = new Date().toISOString().split("T")[0]
  const heading = version.fold(
    () => `## Unreleased (${date})`,
    (v) => `## ${v} (${date})`,
  )
  const breaking = grouped.breaking.isEmpty ? [] : formatSection("BREAKING CHANGES", grouped.breaking, repoUrl)
  const sections = grouped.sections.flatMap((section) => formatSection(section.title, section.commits, repoUrl))

  return [heading, "", ...breaking, ...sections].join("\n")
}

type ChangelogArgs = {
  since: Option<string>
  sinceExplicit: boolean
  output: Option<string>
  version: Option<string>
}

const noArgs: ChangelogArgs = {
  since: Option.none(),
  sinceExplicit: false,
  output: Option.none(),
  version: Option.none(),
}

/** Each flag consumes the argument after it; unknown arguments are skipped. */
function parseChangelogArgs(args: string[], parsed: ChangelogArgs = noArgs): ChangelogArgs {
  const [flag, value] = args
  switch (flag) {
    case undefined:
      return parsed
    case "--since":
      return parseChangelogArgs(args.slice(2), { ...parsed, since: Option(value), sinceExplicit: true })
    case "--output":
      return parseChangelogArgs(args.slice(2), { ...parsed, output: Option(value) })
    case "--version":
      return parseChangelogArgs(args.slice(2), { ...parsed, version: Option(value) })
    default:
      return parseChangelogArgs(args.slice(1), parsed)
  }
}

export function runChangelog(args: string[]): number {
  const config = loadConfig()
  const changelogConfig: ChangelogConfig = config.changelog

  const typeMap = { ...defaultTypeMap, ...changelogConfig.types }
  const exclude = changelogConfig.exclude ? List(changelogConfig.exclude) : defaultExclude

  const { output, version, ...parsedSince } = parseChangelogArgs(args)
  const since = parsedSince.sinceExplicit ? parsedSince.since : getLastTag()

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
