/**
 * Bundles browser modules when the server starts. Every module the entries
 * use, from the application or from node_modules, becomes one file served
 * from memory, its imports rewritten to the other files' URLs, so the browser
 * links them as it would the sources. Modules are tree-shaken first: only the
 * statements and exports the entries reach are served. A file's name changes
 * with the module and with everything it imports, so the files can be cached
 * forever.
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

import * as Jsx from "./Jsx.js"
import * as Resolve from "./Resolve.js"
import * as Shake from "./Shake.js"
import * as Tokenizer from "./Tokenizer.js"

export interface Options {
  /** Absolute file paths of the entry modules. */
  readonly entries: ReadonlyArray<string>
  /** Where the files are served, such as "/assets"; every output path starts with it. */
  readonly prefix: `/${string}`
  /**
   * The directory module names in hashes and messages are relative to.
   * Defaults to process.cwd(). Modules outside it are bundled too, such as a
   * workspace's node_modules above the application, named with "../".
   */
  readonly root?: string
  /** Whether to drop what the entries don't use. Defaults to true; false serves every module whole, for debugging. */
  readonly shake?: boolean
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
  /** The source, as JavaScript: JSX compiled and types stripped. */
  readonly source: string
  readonly scan: Tokenizer.Scan
  /** The real path each import resolved to, in the order of scan.imports; undefined where it couldn't be. */
  readonly targets: ReadonlyArray<string | undefined>
  /** Why an import couldn't be resolved, where it couldn't. */
  readonly problems: ReadonlyArray<Problem | undefined>
  readonly sideEffects: boolean
}

/** A problem with one module, to which bundle adds how the entries lead to it. */
class Problem extends Data.TaggedError("Problem")<{
  readonly message: string
  /** What the chain of imports ends with, when not the module itself: an import it can't resolve. */
  readonly specifier?: string
  readonly cause?: unknown
}> {}

const supported: ReadonlySet<string> = new Set([".js", ".mjs", ".ts", ".mts", ".jsx", ".tsx"])

const unsupported = (extension: string): string =>
  extension === ".cjs" || extension === ".cts"
    ? "only ES modules can be bundled, not CommonJS"
    : "only JavaScript, TypeScript and JSX modules can be bundled"

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** A TokenizerError, with where it happened. */
const located = (name: string, cause: unknown, otherwise: string): Problem =>
  cause instanceof Tokenizer.TokenizerError
    ? new Problem({ message: `${name}:${cause.line}:${cause.column}: ${cause.message}` })
    : new Problem({ message: `${otherwise}: ${messageOf(cause)}`, cause })

/** Reads a module, compiles its JSX, strips its types, and finds its tokens, comments and imports. */
const read = (path: string, name: string): Effect.Effect<Omit<Module, "targets" | "problems" | "sideEffects">, Problem> =>
  Effect.gen(function* () {
    const extension = Path.extname(path).toLowerCase()
    if (!supported.has(extension)) {
      return yield* new Problem({ message: `Can't bundle ${name}: ${unsupported(extension)}` })
    }
    let source = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => new Problem({ message: `Can't read ${name}`, cause })
    })
    // Node can't strip the types around JSX, so JSX is compiled first
    if (extension === ".jsx" || extension === ".tsx") {
      const text = source
      source = yield* Effect.try({
        try: () => Jsx.transform(text),
        catch: (cause) => located(name, cause, `Can't compile the JSX in ${name}`)
      })
    }
    if (extension === ".ts" || extension === ".mts" || extension === ".tsx") {
      const text = source
      source = yield* Effect.try({
        try: () => stripTypeScriptTypes(text, { mode: "strip" }),
        catch: (cause) => new Problem({ message: `Can't strip the types from ${name}: ${messageOf(cause)}`, cause })
      })
    }
    const text = source
    const scan = yield* Effect.try({
      try: () => Tokenizer.scan(text),
      catch: (cause) => located(name, cause, `Can't read ${name}`)
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
  const lines = Tokenizer.lines(source, comment.start, comment.end)
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

const realOf = (path: string, message: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: (cause) => new BundlerError({ message, cause })
  })

const byName = <A extends { readonly name: string }>(a: A, b: A): number => a.name < b.name ? -1 : a.name > b.name ? 1 : 0

/**
 * Bundles the entries and what they use, imported statically or with
 * import("literal"), into one file for each module.
 */
export const bundle = (options: Options): Effect.Effect<Bundle, BundlerError> =>
  Effect.gen(function* () {
    const shake = options.shake ?? true
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
    const entryPaths = new Set(entries.values())

    const load = (path: string): Effect.Effect<Module, Problem> =>
      Effect.gen(function* () {
        const name = nameOf(path)
        const module = yield* read(path, name)
        const resolve = (specifier: string): Effect.Effect<string, Problem> =>
          resolver.resolve(specifier, path).pipe(
            Effect.mapError((error) =>
              new Problem({ message: `Can't resolve ${specifier} (${error.message})`, specifier, cause: error.cause })
            ),
            Effect.flatMap((resolved) =>
              resolved._tag === "File"
                ? Effect.succeed(resolved.path)
                : Effect.fail(new Problem({ message: `Can't bundle ${specifier} for the browser`, specifier }))
            )
          )
        const resolved = yield* Effect.forEach(
          module.scan.imports,
          ({ specifier }): Effect.Effect<Result.Result<string, Problem>, Problem> =>
            // Shaken, an import only matters if what holds it is kept
            shake ? Effect.result(resolve(specifier)) : Effect.map(resolve(specifier), Result.succeed)
        )
        const sideEffects = shake
          ? yield* resolver.sideEffects(path).pipe(
            Effect.mapError((error) => new Problem({ message: `Can't read ${name}'s package.json: ${error.message}` }))
          )
          : true
        return {
          ...module,
          targets: resolved.map((result) => Result.isSuccess(result) ? result.success : undefined),
          problems: resolved.map((result) => Result.isFailure(result) ? result.failure : undefined),
          sideEffects
        }
      })

    // Breadth first, a level at a time, each in order, so that the same files
    // always give the same result, and messages the shortest chain of imports
    const modules = new Map<string, Module>()
    /** Modules that couldn't be read: shaken, a problem only if something kept imports them. */
    const unread = new Map<string, Problem>()
    const importers = new Map<string, string | undefined>()
    let level = [...entryPaths].sort()
    for (const path of level) importers.set(path, undefined)

    const chainOf = (path: string, specifier: string | undefined): string => {
      const chain: Array<string> = specifier === undefined ? [] : [specifier]
      for (let at: string | undefined = path; at !== undefined; at = importers.get(at)) chain.push(nameOf(at))
      return chain.reverse().join(" → ")
    }

    const failure = (path: string, problem: Problem) => {
      const leadsTo = problem.specifier !== undefined || importers.get(path) !== undefined
      return new BundlerError({
        message: leadsTo ? `${problem.message}: ${chainOf(path, problem.specifier)}` : problem.message,
        cause: problem.cause
      })
    }

    while (level.length > 0) {
      const results = yield* Effect.forEach(level, (path) => Effect.result(load(path)), { concurrency })
      const next: Array<string> = []
      for (let index = 0; index < level.length; index++) {
        const path = level[index]!
        const result = results[index]!
        if (Result.isFailure(result)) {
          if (!shake || entryPaths.has(path)) return yield* failure(path, result.failure)
          unread.set(path, result.failure)
          continue
        }
        modules.set(path, result.success)
        for (const target of result.success.targets) {
          if (target !== undefined && !importers.has(target)) {
            importers.set(target, path)
            next.push(target)
          }
        }
      }
      level = next
    }

    const ordered = [...modules.values()].sort(byName)
    const indexes = new Map(ordered.map((module, index) => [module.path, index]))
    const targetsOf = ordered.map((module) =>
      module.targets.map((target) => target === undefined ? undefined : indexes.get(target))
    )

    // What stays of each module: its statements and imports
    let included: Uint8Array
    let renderings: Array<Shake.Rendering | undefined>
    if (shake) {
      const inputs = ordered.map((module, index): Shake.Module => ({
        analysis: Shake.analyze(module.source, module.scan),
        targets: targetsOf[index]!,
        sideEffects: module.sideEffects,
        entry: entryPaths.has(module.path)
      }))
      const marks = Shake.mark(inputs)
      for (const { module, source } of marks.broken) {
        const importer = ordered[module]!
        const problem = importer.problems[source]
        if (problem !== undefined) return yield* failure(importer.path, problem)
        const target = importer.targets[source]!
        return yield* failure(target, unread.get(target)!)
      }
      included = marks.included
      const keepsSideEffects = (index: number) => marks.included[index] === 1 && inputs[index]!.sideEffects
      renderings = ordered.map((module, index) =>
        marks.included[index] === 1
          ? Shake.render(module.source, inputs[index]!, marks, index, keepsSideEffects)
          : undefined
      )
    } else {
      included = new Uint8Array(ordered.length).fill(1)
      renderings = ordered.map((module) => ({ replacements: [], kept: module.scan.imports.map((_, at) => at) }))
    }

    /**
     * A module's text: dropped statements and comments blanked, import and
     * export lists trimmed, and each kept specifier as `literalOf` gives it.
     */
    const textOf = (index: number, literalOf: (at: number) => string): string => {
      const module = ordered[index]!
      const { kept, replacements } = renderings[index]!
      const edits: Array<Edit> = replacements.map(({ end, parts, start }) => ({
        start,
        end,
        text: parts.map((part) => typeof part === "number" ? literalOf(part) : part).join("")
      }))
      // Comments and specifiers outside what was replaced
      let replaced = 0
      const outside = (start: number) => {
        while (replaced < replacements.length && replacements[replaced]!.end <= start) replaced++
        const replacement = replacements[replaced]
        return replacement === undefined || start < replacement.start
      }
      for (const comment of module.scan.comments) {
        if (outside(comment.start)) edits.push({ ...comment, text: blank(module.source, comment) })
      }
      replaced = 0
      for (const at of kept) {
        const { end, start } = module.scan.imports[at]!
        if (outside(start)) edits.push({ start, end, text: literalOf(at) })
      }
      return edit(module.source, edits.sort((a, b) => a.start - b.start))
    }

    // Each kept module by its name, with what it contributes to the hashes of
    // the modules that reach it: its name, its text with the specifiers as
    // written, and where its imports lead
    const kept = ordered.map((_, index) => included[index] === 1 ? renderings[index]!.kept : [])
    const edges = ordered.map((_, index) => kept[index]!.map((at) => targetsOf[index]![at]!))
    const contributions = ordered.map((module, index) =>
      included[index] === 1
        ? sha256([
          module.name,
          textOf(index, (at) => module.source.slice(module.scan.imports[at]!.start, module.scan.imports[at]!.end)),
          ...edges[index]!.map((target) => ordered[target]!.name)
        ].join("\0"))
        : ""
    )

    // A module's hash covers its name and every module it reaches, itself
    // included, so a change anywhere below it renames it, and a cycle needs
    // no module hashed before another
    const urls: Array<string> = []
    const reached = new Int32Array(ordered.length).fill(-1)
    for (let index = 0; index < ordered.length; index++) {
      const module = ordered[index]!
      if (included[index] !== 1) {
        urls.push("")
        continue
      }
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
    const files: Array<File> = []
    ordered.forEach((module, index) => {
      if (included[index] !== 1) return
      const text = textOf(index, (at) => literal(urls[targetsOf[index]![at]!]!, module.scan.imports[at]!.quote))
      files.push({ path: urls[index]!, contentType, body: encoder.encode(text) })
    })
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

    // What each entry imports statically, dependencies first, as the browser evaluates them
    const preloadsOf = (entry: number): ReadonlyArray<string> => {
      const seen = new Set([entry])
      const order: Array<string> = []
      const visit = (index: number): void => {
        kept[index]!.forEach((at, position) => {
          const target = edges[index]![position]!
          if (ordered[index]!.scan.imports[at]!.kind === "static" && !seen.has(target)) {
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
