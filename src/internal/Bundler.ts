/**
 * Bundles browser modules when the server starts. Every module the entries
 * import, from the application or from node_modules, becomes one file served
 * from memory, its imports rewritten to the other files' URLs, so the browser
 * links them as it would the sources. A file's name changes with the module
 * and with everything it imports, so the files can be cached forever.
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import * as Path from "node:path"

import * as Resolve from "./Resolve.js"
import * as Tokenizer from "./Tokenizer.js"

export interface Options {
  /** Absolute file paths of the entry modules. */
  readonly entries: ReadonlyArray<string>
  /** Where the files are served, such as "/assets"; every output path starts with it. */
  readonly prefix: `/${string}`
  /** Files outside this directory are refused. Defaults to process.cwd(). */
  readonly root?: string
}

export interface File {
  /** The URL path the file is served at, such as "/assets/Effect-1a2b3c4d5e6f.js". */
  readonly path: string
  readonly contentType: string
  readonly body: Uint8Array
}

export interface Bundle {
  readonly files: ReadonlyArray<File>
  /** Each entry's URL path, by the entry's absolute file path (as given in Options.entries). */
  readonly entries: ReadonlyMap<string, string>
  /**
   * For each entry (keyed like `entries`), the URL paths of every module it
   * imports statically, directly or not, dependencies first, excluding the
   * entry itself: for <link rel="modulepreload">.
   */
  readonly preloads: ReadonlyMap<string, ReadonlyArray<string>>
}

export class BundlerError extends Data.TaggedError("BundlerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const contentType = "text/javascript; charset=utf-8"

/** How many files are read and resolved at once. */
const concurrency = 16

interface Module {
  /** The real absolute path. */
  readonly path: string
  /** The path relative to the root, with "/" separators. */
  readonly name: string
  /** The source, with any types stripped. */
  readonly source: string
  readonly scan: Tokenizer.Scan
  /** The real path each import resolved to, in the order of scan.imports. */
  readonly targets: ReadonlyArray<string>
}

/** A problem with one module, to which bundle adds how the entries lead to it. */
class Problem extends Data.TaggedError("Problem")<{
  readonly message: string
  /** What the chain of imports ends with, when not the module itself: an import it can't resolve. */
  readonly specifier?: string
  readonly cause?: unknown
}> {}

const unsupported = (extension: string): string | undefined => {
  switch (extension) {
    case ".js":
    case ".mjs":
    case ".ts":
    case ".mts":
      return undefined
    case ".tsx":
      return "JSX can't be bundled; run the server from compiled JavaScript, such as tsc's output"
    case ".jsx":
      return "JSX can't be bundled; import compiled JavaScript instead"
    case ".cjs":
    case ".cts":
      return "only ES modules can be bundled, not CommonJS"
    default:
      return "only JavaScript and TypeScript modules can be bundled"
  }
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** Reads a module, strips its types, and finds its comments and imports. */
const read = (path: string, name: string): Effect.Effect<Omit<Module, "targets">, Problem> =>
  Effect.gen(function* () {
    const extension = Path.extname(path).toLowerCase()
    const reason = unsupported(extension)
    if (reason !== undefined) return yield* new Problem({ message: `Can't bundle ${name}: ${reason}` })
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => new Problem({ message: `Can't read ${name}`, cause })
    })
    const source = extension === ".ts" || extension === ".mts"
      ? yield* Effect.try({
        try: () => stripTypeScriptTypes(text, { mode: "strip" }),
        catch: (cause) => new Problem({ message: `Can't strip the types from ${name}: ${messageOf(cause)}`, cause })
      })
      : text
    const scan = yield* Effect.try({
      try: () => Tokenizer.scan(source),
      catch: (cause) =>
        cause instanceof Tokenizer.TokenizerError
          ? new Problem({ message: `${name}:${cause.line}:${cause.column}: ${cause.message}` })
          : new Problem({ message: `Can't read ${name}: ${messageOf(cause)}`, cause })
    })
    for (const entry of scan.imports) {
      if (entry.attributes) {
        const { column, line } = Tokenizer.position(source, entry.start)
        return yield* new Problem({
          message: `${name}:${line}:${column}: Import attributes can't be bundled: ${entry.specifier}`
        })
      }
    }
    return { path, name, source, scan }
  })

/** Whitespace in place of a comment, keeping the lines of a block comment. */
const blank = (source: string, comment: Tokenizer.Comment): string => {
  if (source.charCodeAt(comment.start + 1) !== 42) return ""
  let lines = 0
  for (let i = comment.start + 2; i < comment.end - 2; i++) {
    const c = source.charCodeAt(i)
    if (c === 10 || c === 0x2028 || c === 0x2029 || (c === 13 && source.charCodeAt(i + 1) !== 10)) lines++
  }
  return lines === 0 ? " " : "\n".repeat(lines)
}

/** A string literal for a URL, with the quote of the literal it replaces. */
const literal = (url: string, quote: Tokenizer.Import["quote"]): string => {
  const body = JSON.stringify(url).slice(1, -1)
  switch (quote) {
    case "\"":
      return `"${body}"`
    case "'":
      return `'${body.replaceAll("\\\"", "\"").replaceAll("'", "\\'")}'`
    case "`":
      return `\`${body.replaceAll("\\\"", "\"").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``
  }
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

const edit = (source: string, edits: ReadonlyArray<Edit>): string => {
  const parts: Array<string> = []
  let at = 0
  for (const { end, start, text } of edits) {
    parts.push(source.slice(at, start), text)
    at = end
  }
  parts.push(source.slice(at))
  return parts.join("")
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

const isInside = (directory: string, path: string): boolean => {
  const relative = Path.relative(directory, path)
  return relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative)
}

const realOf = (path: string, message: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: (cause) => new BundlerError({ message, cause })
  })

/**
 * Bundles the entries and everything they import, statically or with
 * import("literal"), into one file for each module.
 */
export const bundle = (options: Options): Effect.Effect<Bundle, BundlerError> =>
  Effect.gen(function* () {
    const prefix = options.prefix.replace(/\/+$/, "")
    const directory = options.root ?? process.cwd()
    const root = yield* realOf(directory, `Can't find the root directory ${directory}`)
    const nameOf = (path: string) => Resolve.relative(root, path)
    const resolver = Resolve.make(nameOf)

    const entries = new Map<string, string>()
    for (const entry of options.entries) {
      if (!Path.isAbsolute(entry)) {
        return yield* new BundlerError({ message: `An entry must be an absolute path: ${entry}` })
      }
      entries.set(entry, yield* realOf(entry, `Can't find the entry ${entry}`))
    }

    const load = (path: string): Effect.Effect<Module, Problem> =>
      Effect.gen(function* () {
        const name = nameOf(path)
        if (!isInside(root, path)) {
          return yield* new Problem({
            message: `Can't bundle ${path}: it's outside the root directory ${root}; set the root option to include it`
          })
        }
        const module = yield* read(path, name)
        const targets = yield* Effect.forEach(module.scan.imports, ({ specifier }) =>
          resolver.resolve(specifier, path).pipe(
            Effect.mapError((error) =>
              new Problem({ message: `Can't resolve ${specifier} (${error.message})`, specifier, cause: error.cause })
            ),
            Effect.flatMap((resolved) =>
              resolved._tag === "File"
                ? Effect.succeed(resolved.path)
                : Effect.fail(new Problem({ message: `Can't bundle ${specifier} for the browser`, specifier }))
            )
          ))
        return { ...module, targets }
      })

    // Breadth first, a level at a time, each in order, so that the same files
    // always give the same result, and messages the shortest chain of imports
    const modules = new Map<string, Module>()
    const importers = new Map<string, string | undefined>()
    let level = [...new Set(entries.values())].sort()
    for (const path of level) importers.set(path, undefined)

    const chainOf = (path: string, problem: Problem): string => {
      const chain: Array<string> = problem.specifier === undefined ? [] : [problem.specifier]
      for (let at: string | undefined = path; at !== undefined; at = importers.get(at)) chain.push(nameOf(at))
      return chain.reverse().join(" → ")
    }

    while (level.length > 0) {
      const results = yield* Effect.forEach(level, (path) => Effect.result(load(path)), { concurrency })
      const next: Array<string> = []
      for (let index = 0; index < level.length; index++) {
        const path = level[index]!
        const result = results[index]!
        if (Result.isFailure(result)) {
          const problem = result.failure
          const leadsTo = problem.specifier !== undefined || importers.get(path) !== undefined
          return yield* new BundlerError({
            message: leadsTo ? `${problem.message}: ${chainOf(path, problem)}` : problem.message,
            cause: problem.cause
          })
        }
        modules.set(path, result.success)
        for (const target of result.success.targets) {
          if (!importers.has(target)) {
            importers.set(target, path)
            next.push(target)
          }
        }
      }
      level = next
    }

    // Each module by its name, with what it contributes to the hashes of the
    // modules that reach it: its name, source and where its imports lead
    const ordered = [...modules.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const indexes = new Map(ordered.map((module, index) => [module.path, index]))
    const edges = ordered.map((module) => module.targets.map((target) => indexes.get(target)!))
    const blanks = ordered.map((module) =>
      module.scan.comments.map((comment): Edit => ({ ...comment, text: blank(module.source, comment) }))
    )
    const contributions = ordered.map((module, index) =>
      sha256([module.name, edit(module.source, blanks[index]!), ...module.targets.map(nameOf)].join("\0"))
    )

    // A module's hash covers its name and every module it reaches, itself
    // included, so a change anywhere below it renames it, and a cycle needs
    // no module hashed before another
    const urls: Array<string> = []
    const reached = new Int32Array(ordered.length).fill(-1)
    for (let index = 0; index < ordered.length; index++) {
      const module = ordered[index]!
      const stack = [index]
      reached[index] = index
      while (stack.length > 0) {
        for (const target of edges[stack.pop()!]!) {
          if (reached[target] !== index) {
            reached[target] = index
            stack.push(target)
          }
        }
      }
      const hash = createHash("sha256").update(module.name)
      for (let other = 0; other < ordered.length; other++) {
        if (reached[other] === index) hash.update(`\0${contributions[other]}`)
      }
      const base = Path.basename(module.path, Path.extname(module.path)).replace(/[^A-Za-z0-9_-]/g, "_")
      urls.push(`${prefix}/${base}-${hash.digest("hex").slice(0, 12)}.js`)
    }

    const encoder = new TextEncoder()
    const files = ordered.map((module, index): File => {
      const edits = [
        ...blanks[index]!,
        ...module.scan.imports.map(({ end, quote, start }, at): Edit => ({
          start,
          end,
          text: literal(urls[edges[index]![at]!]!, quote)
        }))
      ].sort((a, b) => a.start - b.start)
      return { path: urls[index]!, contentType, body: encoder.encode(edit(module.source, edits)) }
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

    // What each entry imports statically, dependencies first, as the browser evaluates them
    const preloadsOf = (entry: number): ReadonlyArray<string> => {
      const seen = new Set([entry])
      const order: Array<string> = []
      const visit = (index: number): void => {
        ordered[index]!.scan.imports.forEach(({ kind }, at) => {
          const target = edges[index]![at]!
          if (kind === "static" && !seen.has(target)) {
            seen.add(target)
            visit(target)
            order.push(urls[target]!)
          }
        })
      }
      visit(entry)
      return order
    }

    return {
      files,
      entries: new Map([...entries].map(([entry, path]) => [entry, urls[indexes.get(path)!]!])),
      preloads: new Map([...entries].map(([entry, path]) => [entry, preloadsOf(indexes.get(path)!)]))
    }
  })
