/**
 * The parts of Assets that modules running in the browser also import, such as
 * Component and LiveComponent. Unlike Assets.ts, nothing here needs Node.
 */
import * as Context from "effect/Context"
import * as Fiber from "effect/Fiber"

import type * as Html from "../Html.js"

/** What a component contributes to the shared stylesheet; see Component.make. */
export interface Definition {
  readonly tag: string
  /** Styles, already scoped to the component's element. */
  readonly style: string | undefined
}

const definitions = /*#__PURE__*/ new Map<string, Definition>()

/** @internal Called by Component.make. */
export const register = (definition: Definition): void => {
  if (definitions.has(definition.tag)) {
    throw new TypeError(`A component is already defined as <${definition.tag}>`)
  }
  definitions.set(definition.tag, definition)
}

/** The directory of effect-views' own modules, source or compiled, whose stack frames definingFile skips. */
const ownDirectory = new URL("..", import.meta.url).href

/** @internal A stack frame's file, such as "file:///app/Lines.js" from "at View (file:///app/Lines.js:3:9)". */
export const frameFile = (frame: string): string | undefined => {
  const body = frame.trim().replace(/^at (?:async )?/, "")
  // "name (location)" or a bare location; a path may itself contain parentheses
  const location = body.endsWith(")") && body.includes(" (") ? body.slice(body.indexOf(" (") + 2, -1) : body
  return /^(.*):\d+:\d+$/.exec(location)?.[1]
}

/**
 * @internal The file of the module that called `fn`, directly or through
 * effect-views, from the call stack. Only a server needs it, for Assets.layer
 * to bundle that module; elsewhere it is undefined.
 */
export const definingFile = (fn: Function): string | undefined => {
  if (typeof process === "undefined" || typeof Error.captureStackTrace !== "function") return undefined
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 20
  const holder: { stack?: string } = {}
  Error.captureStackTrace(holder, fn)
  Error.stackTraceLimit = limit
  const { fileURLToPath, pathToFileURL } = process.getBuiltinModule("node:url")
  for (const frame of holder.stack?.split("\n").slice(1) ?? []) {
    const file = frameFile(frame)
    if (file === undefined || !(file.startsWith("file://") || file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file))) continue
    const url = file.startsWith("file://") ? file : pathToFileURL(file).href
    if (url.startsWith(ownDirectory)) continue
    return fileURLToPath(url)
  }
  return undefined
}

/** @internal The components defined so far, in the order they were defined. */
export const registered = (): ReadonlyArray<Definition> => [...definitions.values()]

export interface File {
  readonly path: string
  readonly contentType: string
  readonly body: Uint8Array
  /** The body compressed when the layer was built, by content coding, when that is smaller. */
  readonly encoded?: Partial<Record<Encoding, Uint8Array>>
}

/** The content codings Assets.layer compresses files with, in the order it prefers them. */
export type Encoding = "br" | "gzip"

/** Where a live component that runs in the browser loads its code from. */
export interface LiveModule {
  /** The module that defines the component's browser handlers. */
  readonly module: string
  /** Every module it imports, for <link rel="modulepreload">. */
  readonly preloads: ReadonlyArray<string>
}

export interface Manifest {
  /** Where the files are served, such as "/assets". */
  readonly prefix: `/${string}`
  /** Tags for the page head: the stylesheet and the effect-views runtime. */
  readonly head: Html.Html
  /** The stylesheets the head loads, in order. */
  readonly stylesheets: ReadonlyArray<string>
  /** Module scripts the head loads, the effect-views runtime, and the modules they import. */
  readonly modules: ReadonlyArray<string>
  readonly modulePreloads: ReadonlyArray<string>
  /** Where the application's own files are served, by name; see Options.files and url. */
  readonly urls: ReadonlyMap<string, string>
  /** Files served by Assets.layer, by path. */
  readonly files: ReadonlyMap<string, File>
  /** Components whose styles the files include. */
  readonly components: ReadonlySet<string>
  /** Live components that run in the browser, by tag. */
  readonly live: ReadonlyMap<string, LiveModule>
}

/** The assets built when Assets.layer started, available while handling each request. */
export class Assets extends /*#__PURE__*/ Context.Service<Assets, Manifest>()("effect-views/Assets") {}

/** The assets for the request being handled, if Assets.layer is in use. */
export const current = (): Manifest | undefined => {
  const fiber = Fiber.getCurrent()
  return fiber === undefined ? undefined : Context.getOrUndefined(fiber.context, Assets)
}
