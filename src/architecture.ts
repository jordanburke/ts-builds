import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
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
// Brace, bracket and negation globs aren't supported, so this validator and the boundary plugin
// can never read an entry differently.
const UNSUPPORTED_GLOB_CHARS = /[{}[\]!]/

/** Whether a normalized relative path escapes its base: absolute, `..`, or empty. */
const escapes = (raw: string, normalized: string): boolean =>
  raw.trim() === "" || isAbsolute(raw) || normalized === "." || normalized === ".." || normalized.startsWith("../")

/** `path` is `dir` or inside it. Both are POSIX paths relative to the same root. */
const isWithin = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

function ownDirProblems(rootDir: string, name: string, policy: WorkspacePolicy, listed: Set<string>): string[] {
  const wsDir = normalizeDir(policy.dir)
  return (policy.ownDirs ?? []).flatMap((entry) => {
    const own = normalizeDir(entry)
    const label = `${name}: ownDirs entry "${entry}"`
    if (escapes(entry, own)) return [`${label} must be a folder inside ${wsDir}, relative to it`]
    if (GLOB_CHARS.test(own) || UNSUPPORTED_GLOB_CHARS.test(own))
      return [`${label} must be a plain folder path, not a glob`]
    const segments = own.split("/")
    if (segments[0] === "src" || segments[0] === "test") {
      return [`${label} is inside ${segments[0]}, which the boundary rules already check`]
    }
    if (segments.includes("node_modules")) return [`${label} is under node_modules`]
    const full = `${wsDir}/${own}`
    if (!isDirectory(join(rootDir, full))) return [`${label}: ${full} is not a folder`]
    const nested = listed.toArray().filter((dir) => isWithin(dir, full))
    return nested.length > 0 ? [`${label} holds the workspace ${nested.join(", ")}`] : []
  })
}

/** Every file below `rootDir`, as sorted POSIX paths. Skips `node_modules` and dotfiles and dot folders. */
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

/**
 * `allowRootFiles`, expanded to the files each entry names. An entry must match at least one
 * file, and every match must sit outside every workspace: a file inside one belongs to that
 * workspace, and allowing it here would let every workspace's tests import it.
 */
function resolveRootFiles(rootDir: string, entries: readonly string[], listed: Set<string>): RootFiles {
  const globbed = entries.some((entry) => GLOB_CHARS.test(entry)) ? repoFiles(rootDir) : []
  const results = entries.map((entry): RootFiles => {
    const path = toPosix(normalize(entry))
    const label = `testPolicy.allowRootFiles entry "${entry}"`
    if (escapes(entry, path)) return { problems: [`${label} must be a path inside rootDir, relative to it`], files: [] }
    if (UNSUPPORTED_GLOB_CHARS.test(path)) {
      return { problems: [`${label} uses an unsupported glob; only *, ** and ? are supported`], files: [] }
    }
    if (path.split("/").includes("node_modules")) return { problems: [`${label} is under node_modules`], files: [] }
    const matches = GLOB_CHARS.test(path)
      ? globbed.filter((file) => isListedPackage(file, [path]))
      : isFile(join(rootDir, path))
        ? [path]
        : []
    if (matches.length === 0) return { problems: [`${label} matches no file`], files: [] }
    const inside = matches.flatMap((file) =>
      listed
        .toArray()
        .filter((dir) => isWithin(file, dir))
        .map((dir) => `${file} (inside the workspace ${dir})`),
    )
    return inside.length > 0
      ? {
          problems: [
            `${label} matches ${inside.join(", ")}. A workspace's own folders go in its ownDirs, and other workspaces import it as a package`,
          ],
          files: [],
        }
      : { problems: [], files: matches }
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
