import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, normalize, relative, sep } from "node:path"

import { Set } from "functype"

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
}

export type ArchitectureInput = {
  /** The pnpm workspace root, as an absolute path. Pass `import.meta.dirname`. */
  readonly rootDir: string
  /** Every workspace the root's `pnpm-workspace.yaml` lists, keyed by package name. */
  readonly workspaces: Readonly<Record<string, WorkspacePolicy>>
  readonly testPolicy?: {
    /** External packages any test file may import, such as `"vitest"`. */
    readonly allowExternals?: readonly string[]
  }
}

/** A workspace after validation, with what the generators need already worked out. */
export type ResolvedWorkspace = WorkspacePolicy & {
  readonly name: string
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
  readonly testPolicy: { readonly allowExternals: readonly string[] }
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
  const pkgName = readPackageJson(join(rootDir, dir)).name
  return [
    ...(pkgName === name ? [] : [`${name}: ${dir}/package.json is named "${pkgName ?? "(no name)"}", not "${name}"`]),
    ...(isDirectory(join(rootDir, dir, "src"))
      ? []
      : [`${name}: ${dir} has no src directory. Boundary rules check src and test, so code elsewhere is unchecked`]),
  ]
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
 *
 * @interop It throws on purpose: a consumer's eslint.config.js calls it at load, and a bad
 * policy must stop ESLint from starting rather than lint against a wrong one.
 */
export function defineArchitecture(input: ArchitectureInput): Architecture {
  if (!isAbsolute(input.rootDir)) {
    throw new ArchitectureError([`rootDir "${input.rootDir}" must be an absolute path. Pass import.meta.dirname`])
  }
  const rootDir = normalize(input.rootDir)
  const wsFile = join(rootDir, "pnpm-workspace.yaml")
  if (!isFile(wsFile)) throw new ArchitectureError([`rootDir ${rootDir} holds no pnpm-workspace.yaml`])

  const listed = Set(listedWorkspaceDirs(rootDir, readWorkspacePackageGlobs(readFileSync(wsFile, "utf-8"))))
  const entries = Object.entries(input.workspaces)
  const classifiedDirs = Set(entries.map(([, policy]) => normalizeDir(policy.dir)))
  const problems = [
    ...entries.flatMap(([name, policy]) => [
      ...workspaceProblems(rootDir, name, policy, listed),
      ...allowProblems(name, policy, entries),
    ]),
    ...listed
      .toArray()
      .filter((dir) => !classifiedDirs.has(dir))
      .map((dir) => `${dir} is a workspace (${readPackageJson(join(rootDir, dir)).name ?? "no name"}) with no policy`),
  ]
  if (problems.length > 0) throw new ArchitectureError(problems)

  const names = Set(entries.map(([name]) => name))
  const workspaces = Object.fromEntries(
    entries.map(([name, policy]): [string, ResolvedWorkspace] => [
      name,
      resolveWorkspace(rootDir, name, policy, names),
    ]),
  )
  return { rootDir, workspaces, testPolicy: { allowExternals: [...(input.testPolicy?.allowExternals ?? [])] } }
}
