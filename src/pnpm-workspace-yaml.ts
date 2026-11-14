/**
 * Minimal readers for `pnpm-workspace.yaml`, shared by the pnpm 11 doctor checks and
 * the architecture policy validator. Line-based on purpose, like the rest of the pnpm
 * tooling here: no YAML library, top-level blocks only.
 */

/**
 * The lines of the top-level block whose header matches `header`, each trimmed at
 * the end, up to the next top-level key (a line starting with neither whitespace
 * nor `#`). Returns [] when the block is absent.
 */
export function blockLines(yaml: string, header: RegExp): string[] {
  const lines = yaml.split("\n").map((raw) => raw.trimEnd())
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) return []
  const body = lines.slice(start + 1)
  const end = body.findIndex((line) => /^[^\s#]/.test(line))
  return end === -1 ? body : body.slice(0, end)
}

// A YAML list item: `- entry`, `- 'entry'` or `- "entry"`, optionally followed by a `# comment`.
const YAML_LIST_ENTRY = /^\s*-\s*(["']?)([^"'\s#]+)\1\s*(?:#.*)?$/

/**
 * The unquoted items of the top-level list whose header matches `header`: a block list
 * (`- item` lines below it) or a flow list on the header line (`key: [a, 'b']`).
 */
export function readListBlock(yaml: string, header: RegExp): string[] {
  const flow = yaml
    .split("\n")
    .find((line) => header.test(line))
    ?.match(/:\s*\[([^\]]*)\]/)
  if (flow?.[1] !== undefined) {
    return flow[1]
      .split(",")
      .map((item) => item.trim().replace(/^(["'])(.*)\1$/, "$2"))
      .filter((item) => item.length > 0)
  }
  return blockLines(yaml, header)
    .map((line) => YAML_LIST_ENTRY.exec(line)?.[2])
    .filter((entry): entry is string => entry !== undefined)
}

/** The `packages:` globs of a `pnpm-workspace.yaml`, quotes stripped. */
export function readWorkspacePackageGlobs(yaml: string): string[] {
  return readListBlock(yaml, /^packages:/)
}

// One glob token: `**/`, a trailing `/**`, `**`, `*`, `?`, or any other single character.
const GLOB_TOKEN = /\*\*\/|\/\*\*$|\*\*|\*|\?|[^*?]/g
const GLOB_TOKEN_REGEX: Record<string, string> = {
  "**/": "(?:.*/)?",
  "/**": "(?:/.*)?",
  "**": ".*",
  "*": "[^/]*",
  "?": "[^/]",
}

const normalizeGlobPath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")

function globRegExp(glob: string): RegExp {
  const body = normalizeGlobPath(glob).replace(
    GLOB_TOKEN,
    (token) => GLOB_TOKEN_REGEX[token] ?? token.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
  )
  return new RegExp(`^${body}$`)
}

/**
 * Pure matcher: whether pnpm's `packages:` globs list `relDir`, a directory path
 * relative to the workspace root. Covers the forms pnpm documents: `*` (within one
 * path segment), `**` (any depth, including none), `?`, and a leading `!` to exclude.
 * Listed means some include matches and no exclude does.
 */
export function isListedPackage(relDir: string, globs: string[]): boolean {
  const path = normalizeGlobPath(relDir)
  const matches = (glob: string): boolean => globRegExp(glob).test(path)
  const includes = globs.filter((glob) => !glob.startsWith("!"))
  const excludes = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1))
  return includes.some(matches) && !excludes.some(matches)
}
