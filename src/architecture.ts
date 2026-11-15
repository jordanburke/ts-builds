import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { isAbsolute, join, normalize, relative, sep } from "node:path"

import { Set, Try } from "functype"

import { isListedPackage, readWorkspacePackageGlobs } from "./pnpm-workspace-yaml"

/**
 * One workspace's place in the architecture.
 *
 * `type` is a label for the reader. One value means something: `"pure"`, which may
 * import only other pure workspaces, so `defineArchitecture` rejects a pure workspace
 * whose `allow` reaches an impure one.
 */
export type WorkspacePolicy = {
  /** The workspace directory, relative to `rootDir`, such as `"packages/rules"`. */
  readonly dir: string
  /** `"pure"` restricts `allow` to other pure workspaces. Any other value is a label. */
  readonly type: string
  /** Workspace package names, or `@scope/*` globs, this workspace may import. */
  readonly allow?: readonly string[]
  /**
   * External packages this workspace may never import, even when its `package.json`
   * declares them: names such as `"pg"`, or `@scope/*` globs such as `"@ai-sdk/*"`.
   */
  readonly deny?: readonly string[]
  /**
   * Folders of this workspace beside `src` and `test` that its own code may import, such as
   * `"drizzle"`. Workspace-relative plain paths, never globs. Another workspace importing
   * them still fails. ESLint doesn't lint the files in them; `ts-builds depcruise` checks
   * what they import.
   */
  readonly ownDirs?: readonly string[]
}

export type ArchitectureInput = {
  /** The pnpm workspace root, as an absolute path. Pass `import.meta.dirname`. */
  readonly rootDir: string
  /** Every workspace the root's `pnpm-workspace.yaml` lists, keyed by package name. */
  readonly workspaces: Readonly<Record<string, WorkspacePolicy>>
  readonly testPolicy?: {
    /** External packages any test file may import, such as `"vitest"`. */
    readonly allowExternals?: readonly string[]
    /**
     * Repo files outside every workspace that any test file may import, such as
     * `"eslint.config.mjs"`. Repo-relative paths, or globs with `*`, `**` and `?`. A glob
     * doesn't match dotfiles or anything under `node_modules`; list such a file exactly.
     * Source files still may not import them.
     */
    readonly allowRootFiles?: readonly string[]
  }
}

/** A workspace after validation, with what the generators need already worked out. */
export type ResolvedWorkspace = Omit<WorkspacePolicy, "ownDirs"> & {
  readonly name: string
  /** `ownDirs`, normalized: workspace-relative POSIX paths with no trailing slash. */
  readonly ownDirs: readonly string[]
  /** The other workspaces `allow` matches, by package name. */
  readonly allowedWorkspaces: readonly string[]
  /** External packages declared in `dependencies`, `peerDependencies` or `optionalDependencies`. */
  readonly dependencies: readonly string[]
  /** External packages declared in `devDependencies`. */
  readonly devDependencies: readonly string[]
  /** The workspace's `tsconfig.json`, as an absolute path, when it has one. */
  readonly tsconfig: string | undefined
}

export type Architecture = {
  readonly rootDir: string
  readonly workspaces: Readonly<Record<string, ResolvedWorkspace>>
  readonly testPolicy: {
    readonly allowExternals: readonly string[]
    /** `allowRootFiles` with every glob expanded: repo-relative POSIX file paths, sorted. */
    readonly allowRootFiles: readonly string[]
  }
}

/** Every problem `defineArchitecture` found, listed one per line. */
export class ArchitectureError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid architecture:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
    this.name = "ArchitectureError"
    this.problems = problems
  }
}

type PackageJson = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const readPackageJson = (dir: string): PackageJson =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as PackageJson

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory()
const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()
const toPosix = (path: string): string => path.split(sep).join("/")

/**
 * Whether a package-name pattern matches `name`: an exact name, or a glob whose `*`
 * stands for any run of characters other than `/`, such as `@scope/*`.
 */
export function matchesPackagePattern(pattern: string, name: string): boolean {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
  return new RegExp(`^${body}$`).test(name)
}

const CORE_MODULES = builtinModules.map((name) => name.replace(/^node:/, ""))

/**
 * The Node core modules a `deny` entry names, bare (`fs`, never `node:fs`). An entry may
 * be written either way, and may be a glob such as `node:o*`. An entry that names no core
 * module returns [].
 */
export function coreModulesMatching(entry: string): string[] {
  const bare = entry.replace(/^node:/, "")
  return CORE_MODULES.filter((name) => matchesPackagePattern(bare, name))
}

/**
 * The packages an `@types/*` declaration stands for: `@types/x` is `x`, and
 * `@types/scope__name` is `@scope/name`.
 */
export function typedPackages(declared: readonly string[]): string[] {
  return declared
    .filter((name) => name.startsWith("@types/"))
    .map((name) => name.slice("@types/".length))
    .map((name) => (name.includes("__") ? `@${name.replace("__", "/")}` : name))
}

/**
 * The directories below `rootDir` that the root's `packages:` globs list and that hold
 * a `package.json`, as POSIX paths relative to `rootDir`. Skips `node_modules` and hidden
 * directories.
 */
function listedWorkspaceDirs(rootDir: string, globs: readonly string[]): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => join(dir, entry.name))
      .flatMap((sub) => [sub, ...walk(sub)])
  return walk(rootDir)
    .map((dir) => toPosix(relative(rootDir, dir)))
    .filter((rel) => isFile(join(rootDir, rel, "package.json")) && isListedPackage(rel, [...globs]))
}

const declaredNames = (pkg: PackageJson, fields: ReadonlyArray<keyof PackageJson>): string[] =>
  fields.flatMap((field) => Object.keys((pkg[field] as Record<string, string> | undefined) ?? {}))

/** A policy `dir` as a POSIX path relative to rootDir, with no trailing slash. */
const normalizeDir = (dir: string): string => toPosix(normalize(dir)).replace(/\/+$/, "")

function workspaceProblems(rootDir: string, name: string, policy: WorkspacePolicy, listed: Set<string>): string[] {
  const dir = normalizeDir(policy.dir)
  if (isAbsolute(policy.dir) || dir.startsWith("..") || dir === ".") {
    return [`${name}: dir "${policy.dir}" must be a path inside rootDir, relative to it`]
  }
  if (!listed.has(dir)) {
    return [`${name}: dir "${policy.dir}" is not a workspace the root's pnpm-workspace.yaml lists`]
  }
  if (PATTERN_CHARS.test(dir)) {
    return [
      `${name}: dir "${policy.dir}" has one of * ? [ ] { } ( ) ! \\, which the boundary plugin reads as a pattern`,
    ]
  }
  const read = Try(() => readPackageJson(join(rootDir, dir)))
  if (read.isFailure())
    return [
      `${dir}/package.json can't be read: ${read.fold(
        (error) => error.message,
        () => "",
      )}`,
    ]
  const pkgName = read.orThrow().name
  return [
    ...(pkgName === name ? [] : [`${name}: ${dir}/package.json is named "${pkgName ?? "(no name)"}", not "${name}"`]),
    ...(isDirectory(join(rootDir, dir, "src"))
      ? []
      : [`${name}: ${dir} has no src directory. Boundary rules check src and test, so code elsewhere is unchecked`]),
  ]
}

function denyProblems(
  name: string,
  policy: WorkspacePolicy,
  entries: ReadonlyArray<[string, WorkspacePolicy]>,
): string[] {
  return (policy.deny ?? []).flatMap((pattern) => {
    const workspaces = entries.filter(([other]) => matchesPackagePattern(pattern, other)).map(([other]) => other)
    return workspaces.length === 0
      ? []
      : [
          `${name}: deny entry "${pattern}" matches the workspace ${workspaces.join(", ")}. deny is for external packages; leave a workspace out of allow instead`,
        ]
  })
}

function allowProblems(
  name: string,
  policy: WorkspacePolicy,
  entries: ReadonlyArray<[string, WorkspacePolicy]>,
): string[] {
  const others = entries.filter(([other]) => other !== name)
  return (policy.allow ?? []).flatMap((pattern) => {
    const matched = others.filter(([other]) => matchesPackagePattern(pattern, other))
    if (matched.length === 0) return [`${name}: allow entry "${pattern}" matches no other workspace`]
    const impure = policy.type === "pure" ? matched.filter(([, otherPolicy]) => otherPolicy.type !== "pure") : []
    return impure.map(
      ([other, otherPolicy]) =>
        `${name} is pure, but allow entry "${pattern}" reaches ${other}, which is "${otherPolicy.type}"`,
    )
  })
}

const GLOB_CHARS = /[*?]/
/**
 * Characters that make picomatch, the boundary plugin's matcher, read a path as a pattern: a
 * group, a class, braces, a leading `!`, `*`, `?`, or an escape. `a(b).mjs` also matches
 * `ab.mjs`, so no path ts-builds hands the plugin may hold one.
 */
const PATTERN_CHARS = /[*?[\]{}()!\\]/
// In an entry, `*` and `?` are this validator's own globs; the rest are refused.
const UNSUPPORTED_GLOB_CHARS = /[[\]{}()!\\]/

/** Whether a normalized relative path escapes its base: absolute, `..`, or empty. */
const escapes = (raw: string, normalized: string): boolean =>
  raw.trim() === "" || isAbsolute(raw) || normalized === "." || normalized === ".." || normalized.startsWith("../")

/** `path` is `dir` or inside it. Both are POSIX paths relative to the same root. */
const isWithin = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

/**
 * `path`, relative to `rootDir`, as it is on disk: its real case, and through any symlink.
 * Compared on real paths at both ends, so a symlinked root (macOS `/var`) still matches.
 */
const onDisk = (rootDir: string, path: string): string =>
  toPosix(relative(realpathSync.native(rootDir), realpathSync.native(join(rootDir, path))))

/** Every `package.json` below `dir`, relative to `rootDir`. Skips `node_modules`. */
function manifestsBelow(rootDir: string, dir: string): string[] {
  return readdirSync(join(rootDir, dir), { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules")
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return manifestsBelow(rootDir, path)
      return entry.isFile() && entry.name === "package.json" ? [path] : []
    })
}

function ownDirProblems(rootDir: string, name: string, policy: WorkspacePolicy, listed: Set<string>): string[] {
  const wsDir = normalizeDir(policy.dir)
  return (policy.ownDirs ?? []).flatMap((entry) => {
    const own = normalizeDir(entry)
    const label = `${name}: ownDirs entry "${entry}"`
    if (escapes(entry, own)) return [`${label} must be a folder inside ${wsDir}, relative to it`]
    if (PATTERN_CHARS.test(own)) return [`${label} must be a plain folder path, with none of * ? [ ] { } ( ) ! \\`]
    // Lower case: on a case-insensitive filesystem "Test" is the test folder.
    const segments = own.toLowerCase().split("/")
    if (segments[0] === "src" || segments[0] === "test") {
      return [`${label} is inside ${segments[0]}, which the boundary rules already check`]
    }
    if (segments.includes("node_modules")) return [`${label} is under node_modules`]
    const full = `${wsDir}/${own}`
    if (!isDirectory(join(rootDir, full))) return [`${label}: ${full} is not a folder`]
    // The plugin and dependency-cruiser both match the real path, so the entry must name it.
    const real = onDisk(rootDir, full)
    if (real !== full) return [`${label} must name the folder as it is on disk; it resolves to ${real}`]
    const nested = listed.toArray().filter((dir) => isWithin(dir, full))
    if (nested.length > 0) return [`${label} holds the workspace ${nested.join(", ")}`]
    // dependency-cruiser checks a file's packages against its nearest package.json.
    const manifests = manifestsBelow(rootDir, full)
    return manifests.length > 0
      ? [`${label} holds ${manifests.join(", ")}, so its imports would be checked against that file, not ${name}'s`]
      : []
  })
}

/** Every file below `rootDir`, as sorted POSIX paths. Skips `node_modules`, dotfiles, dot folders and symlinks. */
function repoFiles(rootDir: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return walk(path)
        return entry.isFile() ? [toPosix(relative(rootDir, path))] : []
      })
  return walk(rootDir).sort()
}

type RootFiles = { readonly problems: readonly string[]; readonly files: readonly string[] }

const rootFilesProblem = (problem: string): RootFiles => ({ problems: [problem], files: [] })

/** Why the files an entry matched can't be allowed, if they can't. */
function matchProblems(
  rootDir: string,
  label: string,
  path: string,
  matches: readonly string[],
  listed: Set<string>,
): string[] {
  if (matches.length === 0) return [`${label} matches no file`]
  const patterned = matches.filter((file) => PATTERN_CHARS.test(file))
  if (patterned.length > 0) {
    return [
      `${label} matches ${patterned.join(", ")}, whose name has one of * ? [ ] { } ( ) ! \\, so it can't be listed`,
    ]
  }
  if (!GLOB_CHARS.test(path)) {
    const real = onDisk(rootDir, path)
    if (real !== path) return [`${label} must name the file as it is on disk; it resolves to ${real}`]
  }
  const inside = matches.flatMap((file) =>
    listed
      .toArray()
      .filter((dir) => isWithin(file, dir))
      .map((dir) => `${file} (inside the workspace ${dir})`),
  )
  return inside.length > 0
    ? [
        `${label} matches ${inside.join(", ")}. A workspace's own folders go in its ownDirs, and other workspaces import it as a package`,
      ]
    : []
}

/**
 * `allowRootFiles`, expanded to the files each entry names. An entry must match at least one
 * file, and every match must sit outside every workspace: a file inside one belongs to that
 * workspace, and allowing it here would let every workspace's tests import it. Every file it
 * returns is a literal path picomatch reads as itself.
 */
function resolveRootFiles(rootDir: string, entries: readonly string[], listed: Set<string>): RootFiles {
  const globbed = entries.some((entry) => GLOB_CHARS.test(entry)) ? repoFiles(rootDir) : []
  const results = entries.map((entry): RootFiles => {
    const path = toPosix(normalize(entry))
    const label = `testPolicy.allowRootFiles entry "${entry}"`
    if (escapes(entry, path)) return rootFilesProblem(`${label} must be a path inside rootDir, relative to it`)
    if (UNSUPPORTED_GLOB_CHARS.test(path)) {
      return rootFilesProblem(`${label} uses an unsupported character; only the globs *, ** and ? are supported`)
    }
    if (path.toLowerCase().split("/").includes("node_modules"))
      return rootFilesProblem(`${label} is under node_modules`)
    const matches = GLOB_CHARS.test(path)
      ? globbed.filter((file) => isListedPackage(file, [path]))
      : isFile(join(rootDir, path))
        ? [path]
        : []
    const problems = matchProblems(rootDir, label, path, matches, listed)
    return problems.length > 0 ? { problems, files: [] } : { problems: [], files: matches }
  })
  return {
    problems: results.flatMap((result) => result.problems),
    files: [...Set(results.flatMap((result) => result.files)).toArray()].sort(),
  }
}

function resolveWorkspace(
  rootDir: string,
  name: string,
  policy: WorkspacePolicy,
  names: Set<string>,
): ResolvedWorkspace {
  const dir = normalizeDir(policy.dir)
  const pkg = readPackageJson(join(rootDir, dir))
  const external = (dep: string): boolean => !names.has(dep)
  const tsconfig = join(rootDir, dir, "tsconfig.json")
  return {
    ...policy,
    dir,
    name,
    ownDirs: [...Set((policy.ownDirs ?? []).map(normalizeDir)).toArray()],
    allowedWorkspaces: names
      .toArray()
      .filter(
        (other) => other !== name && (policy.allow ?? []).some((pattern) => matchesPackagePattern(pattern, other)),
      ),
    dependencies: declaredNames(pkg, ["dependencies", "peerDependencies", "optionalDependencies"]).filter(external),
    devDependencies: declaredNames(pkg, ["devDependencies"]).filter(external),
    tsconfig: isFile(tsconfig) ? tsconfig : undefined,
  }
}

/**
 * Validates an architecture policy against the workspace on disk and resolves what the
 * boundary generators need. Throws an `ArchitectureError` listing every problem:
 *
 * - `rootDir` is not absolute, or holds no `pnpm-workspace.yaml`.
 * - A workspace the root lists is not classified, or a classified one is not listed.
 * - A workspace's `package.json` name differs from its key, or it has no `src` directory.
 * - An `allow` entry matches no other workspace, or a pure workspace allows an impure one.
 * - An `ownDirs` entry isn't a plain folder inside the workspace, outside `src` and `test`.
 * - A `testPolicy.allowRootFiles` entry matches no file, or a file inside a workspace.
 *
 * @interop It throws on purpose: a consumer's eslint.config.js calls it at load, and a bad
 * policy must stop ESLint from starting rather than lint against a wrong one.
 */
export function defineArchitecture(input: ArchitectureInput): Architecture {
  // A runtime guard for JavaScript callers, whom the types don't bind.
  const workspacesInput: unknown = input.workspaces
  if (typeof workspacesInput !== "object" || workspacesInput === null) {
    throw new ArchitectureError(["workspaces is required: map each workspace package name to its policy"])
  }
  if (!isAbsolute(input.rootDir)) {
    throw new ArchitectureError([`rootDir "${input.rootDir}" must be an absolute path. Pass import.meta.dirname`])
  }
  const rootDir = normalize(input.rootDir)
  const wsFile = join(rootDir, "pnpm-workspace.yaml")
  if (!isFile(wsFile)) throw new ArchitectureError([`rootDir ${rootDir} holds no pnpm-workspace.yaml`])

  const globs = readWorkspacePackageGlobs(readFileSync(wsFile, "utf-8"))
  if (globs.length === 0) throw new ArchitectureError([`${wsFile} has no packages: list, so it is not a monorepo root`])
  const listed = Set(listedWorkspaceDirs(rootDir, globs))
  const entries = Object.entries(input.workspaces)
  const classifiedDirs = Set(entries.map(([, policy]) => normalizeDir(policy.dir)))
  const rootFiles = resolveRootFiles(rootDir, input.testPolicy?.allowRootFiles ?? [], listed)
  const problems = [
    ...entries.flatMap(([name, policy]) => {
      const placement = workspaceProblems(rootDir, name, policy, listed)
      return [
        ...placement,
        // ownDirs are checked against the workspace folder, so only once that folder is valid.
        ...(placement.length === 0 ? ownDirProblems(rootDir, name, policy, listed) : []),
        ...allowProblems(name, policy, entries),
        ...denyProblems(name, policy, entries),
      ]
    }),
    ...rootFiles.problems,
    ...listed
      .toArray()
      .filter((dir) => !classifiedDirs.has(dir))
      .map((dir) => {
        const pkgName = Try(() => readPackageJson(join(rootDir, dir)).name).orElse(undefined)
        return `${dir} is a workspace (${pkgName ?? "no name"}) with no policy`
      }),
  ]
  if (problems.length > 0) throw new ArchitectureError(problems)

  const names = Set(entries.map(([name]) => name))
  const workspaces = Object.fromEntries(
    entries.map(([name, policy]): [string, ResolvedWorkspace] => [
      name,
      resolveWorkspace(rootDir, name, policy, names),
    ]),
  )
  return {
    rootDir,
    workspaces,
    testPolicy: { allowExternals: [...(input.testPolicy?.allowExternals ?? [])], allowRootFiles: rootFiles.files },
  }
}
