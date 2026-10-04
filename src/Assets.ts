import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import * as Html from "./Html.js"

/** What a component contributes to the shared stylesheet; see Component.make. */
export interface Definition {
  readonly tag: string
  /** Styles, already scoped to the component's element. */
  readonly style: string | undefined
}

const definitions = new Map<string, Definition>()

/** @internal Called by Component.make. */
export const register = (definition: Definition): void => {
  if (definitions.has(definition.tag)) {
    throw new TypeError(`A component is already defined as <${definition.tag}>`)
  }
  definitions.set(definition.tag, definition)
}

export interface File {
  readonly path: string
  readonly contentType: string
  readonly body: Uint8Array
}

export interface Manifest {
  /** Where the files are served, such as "/assets". */
  readonly prefix: `/${string}`
  /** Tags for the page head: the stylesheet and htmx. */
  readonly head: Html.Html
  /** Files served by Assets.layer, by path. */
  readonly files: ReadonlyMap<string, File>
  /** Components whose styles the files include. */
  readonly components: ReadonlySet<string>
}

/** The assets built when Assets.layer started, available while handling each request. */
export class Assets extends Context.Service<Assets, Manifest>()("effect-views/Assets") {}

export class AssetsError extends Data.TaggedError("AssetsError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Options {
  /** Where to serve the files. Defaults to "/assets". */
  readonly prefix?: string
  /**
   * htmx is served from the installed `htmx.org` package by default. Pass a URL
   * to load it from elsewhere, or false to leave it out.
   */
  readonly htmx?: false | { readonly url: string }
  /**
   * htmx extensions to serve after htmx, by name, from their `htmx-ext-<name>`
   * packages, such as "sse" from `htmx-ext-sse`.
   */
  readonly extensions?: ReadonlyArray<string>
}

const encoder = new TextEncoder()

const prefixOf = (options: Options | undefined): `/${string}` => {
  const prefix = (options?.prefix ?? "/assets").replace(/\/+$/, "")
  if (!prefix.startsWith("/")) throw new TypeError(`The assets prefix must start with "/": ${prefix}`)
  return prefix as `/${string}`
}

const hash = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex").slice(0, 12)

const readHtmx = Effect.tryPromise({
  try: () => readFile(fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js"))),
  catch: (cause) =>
    new AssetsError({
      message: "Could not find htmx; install htmx.org, or pass htmx: { url } or htmx: false to Assets.layer",
      cause
    })
})

const readExtension = (name: string) =>
  Effect.tryPromise({
    try: () => readFile(fileURLToPath(import.meta.resolve(`htmx-ext-${name}/dist/${name}.min.js`))),
    catch: (cause) =>
      new AssetsError({ message: `Could not find the htmx ${name} extension; install htmx-ext-${name}`, cause })
  })

/** Builds the stylesheet for every component defined so far, with htmx unless left out. */
export const make = (options?: Options): Effect.Effect<Manifest, AssetsError> =>
  Effect.gen(function* () {
    const prefix = prefixOf(options)
    const included = [...definitions.values()]
    const files = new Map<string, File>()
    const head: Array<Html.Html> = []

    const add = (name: string, extension: string, contentType: string, body: Uint8Array): File => {
      const fileName = `${name}-${hash(body)}.${extension}`
      const file: File = { path: `${prefix}/${fileName}`, contentType, body }
      files.set(file.path, file)
      return file
    }

    const styles = included.filter((definition) => definition.style !== undefined)
    if (styles.length > 0) {
      const css = styles.map((definition) => definition.style).join("\n\n")
      const file = add("components", "css", "text/css; charset=utf-8", encoder.encode(css))
      head.push(Html.element("link", { rel: "stylesheet", href: file.path }))
    }

    const htmx = options?.htmx
    if (htmx === undefined) {
      const file = add("htmx", "js", "text/javascript; charset=utf-8", yield* readHtmx)
      head.push(Html.element("script", { src: file.path, defer: true }))
    } else if (htmx !== false) {
      head.push(Html.element("script", { src: htmx.url, defer: true }))
    }

    // Deferred scripts run in order, so extensions load after htmx
    for (const name of options?.extensions ?? []) {
      const file = add(`htmx-ext-${name}`, "js", "text/javascript; charset=utf-8", yield* readExtension(name))
      head.push(Html.element("script", { src: file.path, defer: true }))
    }

    return {
      prefix,
      head: Html.fragment(head),
      files,
      components: new Set(included.map((definition) => definition.tag))
    }
  })

const serve = (manifest: Manifest) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const file = manifest.files.get(new URL(request.url, "http://localhost").pathname)
    if (file === undefined) return HttpServerResponse.text("Not found", { status: 404 })
    return HttpServerResponse.uint8Array(file.body, {
      contentType: file.contentType,
      // File names change with their contents, so they never need to be fetched again
      headers: { "cache-control": "public, max-age=31536000, immutable" }
    })
  })

/**
 * Builds the assets when the server starts. Provide it to `HttpRouter.serve`,
 * rather than adding it to the routes, so that every request can render
 * `<Assets.Head />`, including error pages rendered by middleware. Components
 * must be defined before the layer is built; import their modules first.
 *
 * ```ts
 * const routes = Layer.mergeAll(appRoutes, Assets.routes)
 *
 * routes.pipe(
 *   HttpRouter.serve,
 *   Layer.provide(Assets.layer()),
 *   Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
 * )
 * ```
 */
export const layer = (options?: Options): Layer.Layer<Assets, AssetsError> => Layer.effect(Assets, make(options))

/** Serves the files under the prefix, with names that change with their contents. */
export const routes = Layer.unwrap(Effect.gen(function* () {
  const manifest = yield* Assets
  return Layer.mergeAll(
    HttpRouter.add("GET", `${manifest.prefix}/:file`, serve(manifest)),
    // For HttpRouter.toWebHandler, which handles requests with the services its layers provide
    Layer.succeed(Assets)(manifest)
  )
}))

/** The assets for the request being handled, if Assets.layer is in use. */
export const current = (): Manifest | undefined => {
  const fiber = Fiber.getCurrent()
  return fiber === undefined ? undefined : Context.getOrUndefined(fiber.context, Assets)
}

/**
 * The stylesheet and htmx, for the page head. Requires
 * the Assets service; see layer.
 *
 * ```tsx
 * <head>
 *   <Htmx.Config />
 *   <Assets.Head />
 * </head>
 * ```
 */
export const Head = (): Html.Html => {
  const manifest = current()
  if (manifest === undefined) {
    throw new Error("Assets.Head needs the Assets service; provide Assets.layer() to HttpRouter.serve")
  }
  return manifest.head
}
