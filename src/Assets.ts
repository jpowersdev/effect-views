import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiError from "effect/http-api/HttpApiError"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import * as Csp from "./Csp.js"
import * as Html from "./Html.js"
import * as Bundler from "./internal/Bundler.js"
import { Assets, current, type File, type LiveModule, type Manifest, registered } from "./internal/Manifest.js"
import * as LiveComponent from "./LiveComponent.js"

// Defined apart, without Node, for the modules that also run in the browser
export { Assets, current, register } from "./internal/Manifest.js"
export type { Definition, File, LiveModule, Manifest } from "./internal/Manifest.js"

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
  /**
   * The application's own files, such as its stylesheet and scripts, by the
   * name pages refer to them with in `url`, and where to read them from. They
   * are read when the layer is built and served with the other assets.
   *
   * ```ts
   * files: { "app.css": new URL("../public/app.css", import.meta.url) }
   * ```
   */
  readonly files?: Readonly<Record<string, string | URL>>
  /**
   * The application's API. Live components that run in the browser are found
   * in it, by their endpoints, and their modules are bundled with the
   * effect-views runtime when the layer is built, for the head to load.
   *
   * ```ts
   * Assets.layer({ api: Api })
   * ```
   */
  readonly api?: HttpApi.HttpApi<string, any>
}

const contentTypes: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8"
}

const readFileAt = (name: string, path: string | URL) =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: (cause) => new AssetsError({ message: `Could not read ${name} from ${String(path)}`, cause })
  })

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

const headTags = (
  manifest: Pick<Manifest, "stylesheets" | "scripts" | "modules" | "modulePreloads">,
  nonce: string | undefined
): Html.Html =>
  Html.fragment(
    manifest.stylesheets.map((href) => Html.element("link", { rel: "stylesheet", href })),
    manifest.scripts.map((src) => Html.element("script", { src, defer: true, nonce })),
    manifest.modulePreloads.map((href) => Html.element("link", { rel: "modulepreload", href })),
    manifest.modules.map((src) => Html.element("script", { type: "module", src, nonce }))
  )

/** The tags of the live components in the API that run in the browser, by their module endpoints. */
const browserComponents = (api: HttpApi.HttpApi<string, any>): ReadonlyArray<string> => {
  const tags: Array<string> = []
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const module = Context.getOrUndefined(endpoint.annotations, LiveComponent.BrowserModule)
      if (module !== undefined) tags.push(module.tag)
    }
  })
  return tags
}

/** The runtime's entry: compiled JavaScript beside this module, or its TypeScript source when run from source. */
const runtimeEntry = (): string => {
  const compiled = fileURLToPath(new URL("./client/start.js", import.meta.url))
  return existsSync(compiled) ? compiled : fileURLToPath(new URL("./client/start.ts", import.meta.url))
}

const bundleBrowserComponents = (api: HttpApi.HttpApi<string, any>, prefix: `/${string}`) =>
  Effect.gen(function* () {
    const tags = browserComponents(api)
    if (tags.length === 0) return undefined
    const files = new Map<string, string>()
    for (const tag of tags) {
      const definition = LiveComponent.browserDefinition(tag)
      if (definition === undefined) {
        return yield* new AssetsError({
          message: `<${tag}> runs in the browser, but the module that calls LiveComponent.browser for it has not been ` +
            `loaded; provide its layer to the group that handles <${tag}>, before building Assets.layer`
        })
      }
      if (definition.file === undefined) {
        return yield* new AssetsError({ message: `Could not tell which file defines the browser handlers of <${tag}>` })
      }
      files.set(tag, definition.file)
    }
    const runtime = runtimeEntry()
    const bundle = yield* Bundler.bundle({ entries: [runtime, ...files.values()], prefix }).pipe(
      Effect.mapError((cause) => new AssetsError({ message: cause.message, cause }))
    )
    const runtimePreloads = bundle.preloads.get(runtime) ?? []
    const loaded = new Set([bundle.entries.get(runtime), ...runtimePreloads])
    const live = new Map<string, LiveModule>()
    for (const [tag, file] of files) {
      live.set(tag, {
        module: bundle.entries.get(file)!,
        // The head already preloads the runtime and what it imports, such as effect
        preloads: (bundle.preloads.get(file) ?? []).filter((path) => !loaded.has(path))
      })
    }
    return { files: bundle.files, module: bundle.entries.get(runtime)!, preloads: runtimePreloads, live }
  })

/**
 * Builds the stylesheet for every component defined so far, with htmx unless
 * left out, and bundles the live components in the API that run in the browser.
 */
export const make = (options?: Options): Effect.Effect<Manifest, AssetsError> =>
  Effect.gen(function* () {
    const prefix = prefixOf(options)
    const included = registered()
    const files = new Map<string, File>()
    const stylesheets: Array<string> = []
    const scripts: Array<string> = []
    const modules: Array<string> = []
    const modulePreloads: Array<string> = []
    const urls = new Map<string, string>()
    let live: ReadonlyMap<string, LiveModule> = new Map()

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
      stylesheets.push(file.path)
    }

    const htmx = options?.htmx
    if (htmx === undefined) {
      const file = add("htmx", "js", "text/javascript; charset=utf-8", yield* readHtmx)
      scripts.push(file.path)
    } else if (htmx !== false) {
      scripts.push(htmx.url)
    }

    // Deferred scripts run in order, so extensions load after htmx
    for (const name of options?.extensions ?? []) {
      const file = add(`htmx-ext-${name}`, "js", "text/javascript; charset=utf-8", yield* readExtension(name))
      scripts.push(file.path)
    }

    for (const [name, path] of Object.entries(options?.files ?? {})) {
      const dot = name.lastIndexOf(".")
      const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ""]
      const contentType = contentTypes[extension.toLowerCase()] ?? "application/octet-stream"
      urls.set(name, add(base, extension, contentType, yield* readFileAt(name, path)).path)
    }

    if (options?.api !== undefined) {
      const bundled = yield* bundleBrowserComponents(options.api, prefix)
      if (bundled !== undefined) {
        for (const file of bundled.files) files.set(file.path, file)
        modules.push(bundled.module)
        modulePreloads.push(...bundled.preloads)
        live = bundled.live
      }
    }

    return {
      prefix,
      head: headTags({ stylesheets, scripts, modules, modulePreloads }, undefined),
      stylesheets,
      scripts,
      modules,
      modulePreloads,
      urls,
      files,
      components: new Set(included.map((definition) => definition.tag)),
      live
    }
  })

const fileEndpoint = <const Path extends HttpRouter.PathInput>(path: Path) =>
  HttpApiEndpoint.get("file", path, {
    params: { file: Schema.String },
    success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    error: HttpApiError.NotFound
  })

/**
 * An HttpApi group serving the files under another prefix, which must match
 * the `prefix` given to layer.
 */
export const groupAt = <const Prefix extends `/${string}`>(prefix: Prefix) =>
  HttpApiGroup.make("assets").add(fileEndpoint(`${prefix}/:file`))

/**
 * An HttpApi group serving the files Assets.layer builds, under "/assets": add
 * it to the application's API, and provide `groupLayer` to its
 * `HttpApiBuilder.layer`.
 *
 * ```ts
 * const Api = HttpApi.make("app").add(Views.group).add(Assets.group)
 *
 * HttpApiBuilder.layer(Api).pipe(Layer.provide([ViewsLayer, Assets.groupLayer(Api)]))
 * ```
 */
export const group = groupAt("/assets")

/**
 * Implements the API's assets group: each file, with a name that changes with
 * its contents, cached for a year. Requires the Assets service.
 */
export const groupLayer = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>
): Layer.Layer<HttpApiGroup.Service<ApiId, "assets">, never, Assets> =>
  HttpApiBuilder.group(api as any, "assets", (handlers: any) =>
    Effect.gen(function* () {
      const manifest = yield* Assets
      const declared = (api.groups as unknown as Record<string, HttpApiGroup.Top>)["assets"]?.endpoints["file"]?.path
      if (declared !== `${manifest.prefix}/:file`) {
        return yield* Effect.die(
          `Assets.layer serves files under ${manifest.prefix}, but the API's assets group is at ${String(declared)}; ` +
            `add Assets.groupAt("${manifest.prefix}") to the API instead`
        )
      }
      return handlers.handle("file", ({ params }: { readonly params: { readonly file: string } }) => {
        const file = manifest.files.get(`${manifest.prefix}/${params.file}`)
        if (file === undefined) return Effect.fail(new HttpApiError.NotFound({}))
        return Effect.succeed(HttpServerResponse.uint8Array(file.body, {
          contentType: file.contentType,
          // File names change with their contents, so they never need to be fetched again
          headers: { "cache-control": "public, max-age=31536000, immutable" }
        }))
      })
    })) as any

/**
 * Builds the assets when the server starts. Provide it to `HttpRouter.serve`,
 * rather than only to the API's layer, so that every request can render
 * `<Assets.Head />`, including error pages rendered by middleware; with
 * `HttpRouter.toWebHandler`, use `Layer.provideMerge`. Components must be
 * defined before the layer is built; import their modules first.
 *
 * ```ts
 * HttpApiBuilder.layer(Api).pipe(
 *   Layer.provide([ViewsLayer, Assets.groupLayer(Api)]),
 *   HttpRouter.serve,
 *   Layer.provide(Assets.layer()),
 *   Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
 * )
 * ```
 */
export const layer = (options?: Options): Layer.Layer<Assets, AssetsError> => Layer.effect(Assets, make(options))

/**
 * Where one of the application's files is served, for a link or a script:
 * `<link rel="stylesheet" href={Assets.url("app.css")} />`. Requires the
 * Assets service, built with the file in `files`.
 */
export const url = (name: string): string => {
  const manifest = current()
  if (manifest === undefined) {
    throw new Error("Assets.url needs the Assets service; provide Assets.layer() to HttpRouter.serve")
  }
  const path = manifest.urls.get(name)
  if (path === undefined) throw new Error(`Assets.layer has no file named ${name}; add it to the files option`)
  return path
}

/**
 * The stylesheet, htmx, and the effect-views runtime when live components run
 * in the browser, for the page head, with the response's nonce on the scripts
 * when `Csp.layer` is in use. Requires the Assets service; see layer.
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
  const nonce = Csp.nonce()
  return nonce === undefined ? manifest.head : headTags(manifest, nonce)
}
