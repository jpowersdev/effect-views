/**
 * Resolves import specifiers to files as Node resolves ES modules, but with
 * the conditions a browser bundle needs: "browser", "import" and "default".
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { readFile, realpath, stat } from "node:fs/promises"
import { isBuiltin } from "node:module"
import * as Path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The package.json conditions matched, in Node's way: the first key of a conditions object that is one of these. */
export const conditions: ReadonlyArray<string> = ["browser", "import", "default"]

export type Resolved =
  | { readonly _tag: "File"; readonly path: string }
  | { readonly _tag: "Builtin" }

/** Why a specifier can't be resolved, such as "there's no src/missing.js". */
export class ResolveError extends Data.TaggedError("ResolveError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Resolver {
  /** Resolves a specifier imported by a module, given as its real absolute path, to a real absolute path. */
  readonly resolve: (specifier: string, importer: string) => Effect.Effect<Resolved, ResolveError>
  /**
   * Whether merely importing a module may do something, from its package's
   * "sideEffects": true when absent, false when false, or whether one of its
   * globs matches.
   */
  readonly sideEffects: (path: string) => Effect.Effect<boolean, ResolveError>
}

type Json = null | boolean | number | string | ReadonlyArray<Json> | JsonObject
interface JsonObject {
  readonly [key: string]: Json
}

const isObject = (json: Json | undefined): json is JsonObject =>
  typeof json === "object" && json !== null && !Array.isArray(json)

const isArray = (json: Json): json is ReadonlyArray<Json> => Array.isArray(json)

/** Segments a package target may not have after its leading "./", as Node checks. */
const invalidSegment = /(^|\\|\/)((\.|%2e)(\.|%2e)?|node_modules)?(\\|\/|$)/i
const invalidMatch = /(^|\\|\/)((\.|%2e)(\.|%2e)?|node_modules)(\\|\/|$)/i

const isUrl = (specifier: string): boolean => /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(specifier)

/** Node's PATTERN_KEY_COMPARE: longer prefixes before the `*` first, then longer keys. */
const comparePatterns = (a: string, b: string): number => {
  const baseA = a.indexOf("*")
  const baseB = b.indexOf("*")
  if (baseA !== baseB) return baseB - baseA
  return b.length - a.length
}

/** The entry of an "exports" or "imports" map for a subpath or name, exactly or by a single-`*` pattern. */
const matchOf = (
  map: JsonObject,
  key: string
): { readonly target: Json; readonly match: string | undefined } | undefined => {
  if (Object.hasOwn(map, key) && !key.includes("*")) return { target: map[key] as Json, match: undefined }
  let best: string | undefined
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf("*")
    if (star === -1 || pattern.indexOf("*", star + 1) !== -1) continue
    const base = pattern.slice(0, star)
    const trailer = pattern.slice(star + 1)
    if (
      key.startsWith(base) && key !== base &&
      (trailer === "" || (key.endsWith(trailer) && key.length >= pattern.length)) &&
      (best === undefined || comparePatterns(pattern, best) < 0)
    ) {
      best = pattern
    }
  }
  if (best === undefined) return undefined
  const star = best.indexOf("*")
  return { target: map[best] as Json, match: key.slice(star, key.length - (best.length - star - 1)) }
}

/**
 * Node's PACKAGE_TARGET_RESOLVE, without touching the file system: the
 * candidates a target gives, in order (more than one from an array), as
 * absolute paths, or package specifiers for "imports". Undefined when no
 * condition matches, null when the target is null: not exported.
 */
const targetOf = (
  directory: string,
  target: Json,
  match: string | undefined,
  isImports: boolean
): ReadonlyArray<string> | null | undefined => {
  if (typeof target === "string") {
    const replaced = match === undefined ? target : target.replaceAll("*", match)
    if (!target.startsWith("./")) {
      // "imports" may map to another package: "#dep": "dep"
      const isPackage = isImports && !target.startsWith("../") && !target.startsWith("/") && !isUrl(target)
      return isPackage ? [replaced] : []
    }
    if (invalidSegment.test(target.slice(2))) return []
    if (match !== undefined && invalidMatch.test(match)) return []
    const path = Path.join(directory, replaced)
    return path.startsWith(directory + Path.sep) ? [path] : []
  }
  if (isArray(target)) {
    if (target.length === 0) return null
    const candidates: Array<string> = []
    for (const item of target) candidates.push(...targetOf(directory, item, match, isImports) ?? [])
    return candidates.length === 0 ? null : candidates
  }
  if (isObject(target)) {
    for (const [key, value] of Object.entries(target)) {
      if (!conditions.includes(key)) continue
      const resolved = targetOf(directory, value, match, isImports)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }
  return null
}

const posix = (path: string): string => path.split(Path.sep).join("/")

/** The sources a TypeScript or JSX module may mean by a JavaScript path, in the order tsc tries them. */
const sourcesOf = (path: string): ReadonlyArray<string> => {
  const extension = Path.extname(path)
  const base = path.slice(0, -extension.length)
  switch (extension) {
    case ".js":
      return [`${base}.ts`, `${base}.tsx`, `${base}.jsx`]
    case ".mjs":
      return [`${base}.mts`]
    case ".jsx":
      return [`${base}.tsx`]
    default:
      return []
  }
}

/**
 * A "sideEffects" glob as bundlers read it: relative to the package, and
 * matching anywhere when it has no "/", as in "*.css".
 */
const globOf = (pattern: string): RegExp => {
  let glob = pattern.replace(/^\.\//, "")
  if (!glob.includes("/")) glob = `**/${glob}`
  let regex = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/"
      regex += slash ? "(?:.*/)?" : ".*"
      i += slash ? 2 : 1
    } else if (c === "*") {
      regex += "[^/]*"
    } else if (c === "?") {
      regex += "[^/]"
    } else if (c === "{") {
      const close = glob.indexOf("}", i)
      if (close === -1) {
        regex += "\\{"
      } else {
        const options = glob.slice(i + 1, close).split(",").map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&"))
        regex += `(?:${options.join("|")})`
        i = close
      }
    } else {
      regex += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&")
    }
  }
  return new RegExp(`^${regex}$`)
}

/**
 * A resolver, with caches for one bundle. `display` shows a path in messages,
 * such as relative to the root.
 */
export const make = (display: (path: string) => string): Resolver => {
  const packages = new Map<string, Promise<JsonObject | undefined>>()
  const scopes = new Map<string, Promise<string | undefined>>()
  const reals = new Map<string, Promise<string>>()

  const statOf = (path: string) => Effect.promise(() => stat(path).catch(() => undefined))

  const isFile = (path: string) => Effect.map(statOf(path), (stats) => stats?.isFile() === true)

  const isDirectory = (path: string) => Effect.map(statOf(path), (stats) => stats?.isDirectory() === true)

  const realOf = (path: string) =>
    Effect.tryPromise({
      try: () => {
        let real = reals.get(path)
        if (real === undefined) reals.set(path, real = realpath(path))
        return real
      },
      catch: (cause) => new ResolveError({ message: `can't find the real path of ${display(path)}`, cause })
    })

  const file = (path: string) => Effect.map(realOf(path), (real): Resolved => ({ _tag: "File", path: real }))

  /** A directory's package.json, if it has one. */
  const packageOf = (directory: string) =>
    Effect.tryPromise({
      try: () => {
        let read = packages.get(directory)
        if (read === undefined) {
          read = readFile(Path.join(directory, "package.json"), "utf8").then(
            (text) => {
              const json = JSON.parse(text) as Json
              return isObject(json) ? json : {}
            },
            (cause: unknown) => {
              if ((cause as { readonly code?: unknown }).code === "ENOENT") return undefined
              throw cause
            }
          )
          packages.set(directory, read)
        }
        return read
      },
      catch: (cause) =>
        new ResolveError({ message: `${display(Path.join(directory, "package.json"))} can't be read`, cause })
    })

  /** The directory of the nearest package.json at or above a directory, stopping at node_modules as Node does. */
  const scopeOf = (directory: string): Effect.Effect<string | undefined> =>
    Effect.promise(() => {
      let scope = scopes.get(directory)
      if (scope === undefined) {
        scope = (async () => {
          for (let dir = directory;; dir = Path.dirname(dir)) {
            if (Path.basename(dir) === "node_modules") return undefined
            const stats = await stat(Path.join(dir, "package.json")).catch(() => undefined)
            if (stats?.isFile() === true) return dir
            if (Path.dirname(dir) === dir) return undefined
          }
        })()
        scopes.set(directory, scope)
      }
      return scope
    })

  /** The first candidate that exists; a package specifier, from "imports", is resolved from the package. */
  const firstOf = (
    candidates: ReadonlyArray<string>,
    directory: string,
    describe: (first: string) => string
  ): Effect.Effect<Resolved, ResolveError> =>
    Effect.gen(function* () {
      for (const candidate of candidates) {
        if (!Path.isAbsolute(candidate)) return yield* resolve(candidate, Path.join(directory, "package.json"))
        if (yield* isFile(candidate)) return yield* file(candidate)
      }
      return yield* new ResolveError({ message: describe(candidates[0] ?? directory) })
    })

  const relativeOrAbsolute = (specifier: string, importer: string) =>
    Effect.gen(function* () {
      let path: string
      try {
        path = fileURLToPath(new URL(specifier, pathToFileURL(importer)))
      } catch (cause) {
        return yield* new ResolveError({ message: "it isn't a valid file URL", cause })
      }
      if (yield* isFile(path)) return yield* file(path)
      // TypeScript and JSX sources import "./x.js" for "./x.ts", "./x.tsx" or "./x.jsx"
      if (/\.(m?ts|tsx|jsx)$/.test(importer)) {
        for (const source of sourcesOf(path)) {
          if (yield* isFile(source)) return yield* file(source)
        }
      }
      return yield* new ResolveError({ message: `there's no ${display(path)}` })
    })

  /** A package's entry or one of its subpaths, from its "exports", or else its files. */
  const inPackage = (directory: string, name: string, subpath: string) =>
    Effect.gen(function* () {
      const json = yield* packageOf(directory)
      const exports = json?.["exports"]
      const shown = subpath === "." ? name : `${name}/${subpath.slice(2)}`
      if (exports !== undefined && exports !== null) {
        let target: Json | undefined
        let match: string | undefined
        if (isObject(exports) && Object.keys(exports).some((key) => key.startsWith("."))) {
          if (!Object.keys(exports).every((key) => key.startsWith("."))) {
            return yield* new ResolveError({
              message: `${name}'s package.json "exports" mixes subpaths and conditions`
            })
          }
          const found = matchOf(exports, subpath)
          target = found?.target
          match = found?.match
        } else if (subpath === ".") {
          // A string, an array, or conditions: the package's entry
          target = exports
        }
        const candidates = target === undefined ? undefined : targetOf(directory, target, match, false)
        if (candidates === undefined || candidates === null) {
          return yield* new ResolveError({ message: `${name} doesn't export ${subpath}` })
        }
        if (candidates.length === 0) {
          return yield* new ResolveError({ message: `${name}'s "exports" maps ${subpath} outside the package` })
        }
        return yield* firstOf(
          candidates,
          directory,
          (first) => `${name} exports ${subpath} as ${display(first)}, which doesn't exist`
        )
      }
      if (subpath !== ".") {
        const path = Path.join(directory, subpath)
        if (yield* isFile(path)) return yield* file(path)
        return yield* new ResolveError({ message: `there's no ${display(path)} for ${shown}` })
      }
      for (const field of ["module", "main"]) {
        const entry = json?.[field]
        if (typeof entry !== "string") continue
        const path = Path.join(directory, entry)
        for (const candidate of [path, `${path}.js`, Path.join(path, "index.js")]) {
          if (yield* isFile(candidate)) return yield* file(candidate)
        }
      }
      const index = Path.join(directory, "index.js")
      if (yield* isFile(index)) return yield* file(index)
      return yield* new ResolveError({ message: `${name} has no "exports", "module", "main" or index.js` })
    })

  const bare = (specifier: string, importer: string) =>
    Effect.gen(function* () {
      const slash = specifier.indexOf("/", specifier.startsWith("@") ? specifier.indexOf("/") + 1 : 0)
      const name = slash === -1 ? specifier : specifier.slice(0, slash)
      const subpath = slash === -1 ? "." : `.${specifier.slice(slash)}`
      if (
        name === "" || name.startsWith(".") || name.includes("\\") || name.includes("%") ||
        (name.startsWith("@") && !/^@[^/]+\/[^/]+$/.test(name))
      ) {
        return yield* new ResolveError({ message: "it isn't a valid package name" })
      }
      const from = Path.dirname(importer)

      // A package may import itself by name, as the effect-views examples do
      const scope = yield* scopeOf(from)
      if (scope !== undefined && (yield* packageOf(scope))?.["name"] === name) {
        return yield* inPackage(scope, name, subpath)
      }

      for (let dir = from;; dir = Path.dirname(dir)) {
        if (Path.basename(dir) !== "node_modules") {
          const candidate = Path.join(dir, "node_modules", name)
          if (yield* isDirectory(candidate)) return yield* inPackage(yield* realOf(candidate), name, subpath)
        }
        if (Path.dirname(dir) === dir) break
      }
      return yield* new ResolveError({ message: `there's no ${name} in node_modules` })
    })

  const imports = (specifier: string, importer: string) =>
    Effect.gen(function* () {
      if (specifier === "#" || specifier.startsWith("#/")) {
        return yield* new ResolveError({ message: "it isn't a valid \"imports\" name" })
      }
      const scope = yield* scopeOf(Path.dirname(importer))
      const map = scope === undefined ? undefined : (yield* packageOf(scope))?.["imports"]
      if (scope === undefined || !isObject(map)) {
        return yield* new ResolveError({
          message: scope === undefined
            ? `there's no package.json above ${display(importer)}`
            : `${display(Path.join(scope, "package.json"))} has no "imports"`
        })
      }
      const found = matchOf(map, specifier)
      const candidates = found === undefined ? undefined : targetOf(scope, found.target, found.match, true)
      if (candidates === undefined || candidates === null || candidates.length === 0) {
        return yield* new ResolveError({
          message: `${display(Path.join(scope, "package.json"))} "imports" doesn't map ${specifier}`
        })
      }
      return yield* firstOf(
        candidates,
        scope,
        (first) => `${specifier} is imported from ${display(first)}, which doesn't exist`
      )
    })

  const resolve = (specifier: string, importer: string): Effect.Effect<Resolved, ResolveError> => {
    if (
      specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") ||
      specifier === "." || specifier === ".." || specifier.startsWith("file:")
    ) {
      return relativeOrAbsolute(specifier, importer)
    }
    if (specifier.startsWith("node:") || isBuiltin(specifier)) return Effect.succeed({ _tag: "Builtin" })
    if (specifier.startsWith("#")) return imports(specifier, importer)
    if (isUrl(specifier)) return Effect.fail(new ResolveError({ message: "only files and packages can be bundled" }))
    return bare(specifier, importer)
  }

  const globs = new Map<string, RegExp>()

  const sideEffects = (path: string) =>
    Effect.gen(function* () {
      const scope = yield* scopeOf(Path.dirname(path))
      if (scope === undefined) return true
      const value = (yield* packageOf(scope))?.["sideEffects"]
      if (value === false) return false
      if (value === undefined || value === null || !isArray(value)) return true
      const relative = posix(Path.relative(scope, path))
      return value.some((pattern) => {
        if (typeof pattern !== "string") return false
        let glob = globs.get(pattern)
        if (glob === undefined) globs.set(pattern, glob = globOf(pattern))
        return glob.test(relative)
      })
    })

  return { resolve, sideEffects }
}

/** A path relative to a directory, with "/" separators, for messages and file names. */
export const relative = (directory: string, path: string): string => posix(Path.relative(directory, path))
