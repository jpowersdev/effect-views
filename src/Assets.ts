import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as HttpRouter from "effect/http/HttpRouter"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
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
import { promisify } from "node:util"
import * as Zlib from "node:zlib"

import * as Csp from "./Csp.js"
import * as Html from "./Html.js"
import * as Bundler from "./internal/Bundler.js"
import * as Protocol from "./internal/Protocol.js"
import {
  Assets,
  current,
  type Encoding,
  type File,
  type LiveModule,
  type Manifest,
  registered
} from "./internal/Manifest.js"
import * as LiveComponent from "./LiveComponent.js"

// Defined apart, without Node, for the modules that also run in the browser
export { Assets, current, register } from "./internal/Manifest.js"
export type { Definition, Encoding, File, LiveModule, Manifest } from "./internal/Manifest.js"

export class AssetsError extends Data.TaggedError("AssetsError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Options {
  /** Where to serve the files. Defaults to "/assets". */
  readonly prefix?: string
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
   * effect-views runtime when the layer is built.
   *
   * ```ts
   * Assets.layer({ api: Api })
   * ```
   */
  readonly api?: HttpApi.HttpApi<string, any>
  /**
   * Whether to compress the files when the layer is built, with brotli at its
   * highest quality and with gzip, to send each request the smallest it
   * accepts. Defaults to true; pass false when a proxy or CDN in front of the
   * server compresses them.
   */
  readonly compress?: boolean
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

const brotli = promisify(Zlib.brotliCompress)
const gzip = promisify(Zlib.gzip)

/** Text compresses well; images, fonts and archives are compressed already. */
const isCompressible = (contentType: string): boolean =>
  /^text\/|javascript|json|svg|xml/.test(contentType)

/**
 * A file with its body compressed, keeping each coding only when it is
 * smaller. The files never change once built, so they are compressed once,
 * as much as each coding allows, rather than for each request.
 */
const compressed = (file: File): Effect.Effect<File, AssetsError> =>
  !isCompressible(file.contentType) || file.body.length < 256
    ? Effect.succeed(file)
    : Effect.tryPromise({
      try: async () => {
        const [br, gz] = await Promise.all([
          brotli(file.body, {
            params: {
              [Zlib.constants.BROTLI_PARAM_QUALITY]: Zlib.constants.BROTLI_MAX_QUALITY,
              [Zlib.constants.BROTLI_PARAM_SIZE_HINT]: file.body.length
            }
          }),
          gzip(file.body, { level: Zlib.constants.Z_BEST_COMPRESSION })
        ])
        const encoded: Partial<Record<Encoding, Uint8Array>> = {}
        if (br.length < file.body.length) encoded.br = new Uint8Array(br)
        if (gz.length < file.body.length) encoded.gzip = new Uint8Array(gz)
        return { ...file, encoded }
      },
      catch: (cause) => new AssetsError({ message: `Could not compress ${file.path}`, cause })
    })

const preference: ReadonlyArray<Encoding> = ["br", "gzip"]

/**
 * The coding to send, from a request's Accept-Encoding: the first one the
 * server prefers that the request accepts with a weight above zero, directly
 * or through `*`. Undefined means the body as it is.
 */
export const negotiate = (acceptEncoding: string | undefined, available: ReadonlyArray<Encoding>): Encoding | undefined => {
  if (acceptEncoding === undefined) return undefined
  const weights = new Map<string, number>()
  for (const part of acceptEncoding.split(",")) {
    const [name = "", ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase())
    const weight = parameters.find((parameter) => parameter.startsWith("q="))
    if (name !== "") weights.set(name, weight === undefined ? 1 : Number(weight.slice(2)))
  }
  return preference.find((encoding) => {
    if (!available.includes(encoding)) return false
    const weight = weights.get(encoding) ?? weights.get("*")
    return weight !== undefined && weight > 0
  })
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

const headTags = (
  manifest: Pick<Manifest, "stylesheets" | "modules" | "modulePreloads">,
  nonce: string | undefined,
  config: Protocol.Config
): Html.Html =>
  Html.fragment(
    Object.keys(config).length === 0
      ? undefined
      : Html.element("meta", { name: Protocol.configMeta, content: JSON.stringify(config) }),
    manifest.stylesheets.map((href) => Html.element("link", { rel: "stylesheet", href })),
    manifest.modulePreloads.map((href) => Html.element("link", { rel: "modulepreload", href })),
    manifest.modules.map((src) => Html.element("script", { type: "module", src, nonce }))
  )

/** The live components in the API, by tag, and where each runs, from their endpoints. */
const liveComponents = (api: HttpApi.HttpApi<string, any>): ReadonlyMap<string, LiveComponent.Runs> => {
  const components = new Map<string, LiveComponent.Runs>()
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const live = Context.getOrUndefined(endpoint.annotations, LiveComponent.Endpoint)
      if (live !== undefined) components.set(live.tag, live.runs)
    }
  })
  return components
}

/** The runtime's entry: compiled JavaScript beside this module, or its TypeScript source when run from source. */
const runtimeEntry = (): string => {
  const compiled = fileURLToPath(new URL("./client/start.js", import.meta.url))
  return existsSync(compiled) ? compiled : fileURLToPath(new URL("./client/start.ts", import.meta.url))
}

/** The effect-views runtime, with the modules of the live components in the API that run in the browser. */
const bundleRuntime = (api: HttpApi.HttpApi<string, any> | undefined, prefix: `/${string}`) =>
  Effect.gen(function* () {
    const components = api === undefined ? new Map<string, LiveComponent.Runs>() : liveComponents(api)
    const files = new Map<string, string>()
    for (const [tag, runs] of components) {
      if (runs !== "browser") continue
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
 * Builds the stylesheet for every component defined so far, and bundles the
 * effect-views runtime, with the modules of the live components in the API
 * that run in the browser.
 */
export const make = (options?: Options): Effect.Effect<Manifest, AssetsError> =>
  Effect.gen(function* () {
    const prefix = prefixOf(options)
    const included = registered()
    const files = new Map<string, File>()
    const stylesheets: Array<string> = []
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

    for (const [name, path] of Object.entries(options?.files ?? {})) {
      const dot = name.lastIndexOf(".")
      const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ""]
      const contentType = contentTypes[extension.toLowerCase()] ?? "application/octet-stream"
      urls.set(name, add(base, extension, contentType, yield* readFileAt(name, path)).path)
    }

    const bundled = yield* bundleRuntime(options?.api, prefix)
    for (const file of bundled.files) files.set(file.path, file)
    modules.push(bundled.module)
    modulePreloads.push(...bundled.preloads)
    live = bundled.live

    if (options?.compress !== false) {
      const all = yield* Effect.forEach(files.values(), compressed, { concurrency: 8 })
      for (const file of all) files.set(file.path, file)
    }

    return {
      prefix,
      head: headTags({ stylesheets, modules, modulePreloads }, undefined, {}),
      stylesheets,
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
      return handlers.handle("file", ({ params, request }: {
        readonly params: { readonly file: string }
        readonly request: HttpServerRequest.HttpServerRequest
      }) => {
        const file = manifest.files.get(`${manifest.prefix}/${params.file}`)
        if (file === undefined) return Effect.fail(new HttpApiError.NotFound({}))
        const encoded = file.encoded ?? {}
        const encoding = negotiate(request.headers["accept-encoding"], Object.keys(encoded) as Array<Encoding>)
        return Effect.succeed(HttpServerResponse.uint8Array(encoding === undefined ? file.body : encoded[encoding]!, {
          contentType: file.contentType,
          headers: {
            // File names change with their contents, so they never need to be fetched again
            "cache-control": "public, max-age=31536000, immutable",
            ...(file.encoded === undefined ? {} : { vary: "Accept-Encoding" }),
            ...(encoding === undefined ? {} : { "content-encoding": encoding })
          }
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

export interface HeadProps extends Protocol.Config {}

/**
 * The stylesheet and the effect-views runtime, for the page head, with the
 * response's nonce on the scripts when `Csp.layer` is in use. Pass
 * `errorTarget` to put error responses to the runtime's requests into the
 * page, such as the fragments ErrorPage.layer renders. Requires the Assets
 * service; see layer.
 *
 * ```tsx
 * <head>
 *   <Assets.Head errorTarget="#errors" />
 * </head>
 * ```
 */
export const Head = (props?: HeadProps): Html.Html => {
  const manifest = current()
  if (manifest === undefined) {
    throw new Error("Assets.Head needs the Assets service; provide Assets.layer() to HttpRouter.serve")
  }
  const nonce = Csp.nonce()
  const config: Protocol.Config = props?.errorTarget === undefined ? {} : { errorTarget: props.errorTarget }
  return nonce === undefined && Object.keys(config).length === 0 ? manifest.head : headTags(manifest, nonce, config)
}
