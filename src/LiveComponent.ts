import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as OpenApi from "effect/http-api/OpenApi"

import * as Component from "./Component.js"
import * as Html from "./Html.js"
import * as HttpFormEndpoint from "./HttpFormEndpoint.js"
import * as Manifest from "./internal/Manifest.js"
import type * as LiveAction from "./LiveAction.js"
import * as On from "./On.js"

export const TypeId = "~effect-views/LiveComponent" as const

// Signing -----------------------------------------------------------------------

// This module also runs in the browser, for components that run there, so Node's
// crypto is loaded when a server first signs or checks state, not imported.
const nodeCrypto = () => process.getBuiltinModule("node:crypto")

let defaultKey: Uint8Array | undefined

/**
 * The key that signs live components' state. By default it is chosen at
 * random when first used, so pages rendered before a restart, or by another
 * server, stop accepting actions. Provide `LiveComponent.secret(...)` to share one.
 */
export const Secret = /*#__PURE__*/ Context.Reference<Uint8Array>("effect-views/LiveComponent/Secret", {
  defaultValue: () => defaultKey ??= nodeCrypto().randomBytes(32)
})

/**
 * Signs state with a secret, for servers that should accept each other's pages.
 * Provide it to `HttpRouter.serve`, so that pages and actions use the same key.
 */
export const secret = (value: Redacted.Redacted<string>): Layer.Layer<never> =>
  Layer.succeed(Secret)(new TextEncoder().encode(Redacted.value(value)))

const currentKey = (): Uint8Array => {
  const fiber = Fiber.getCurrent()
  return fiber === undefined ? Secret.defaultValue() : Context.get(fiber.context, Secret)
}

/** The name of the hidden input that carries a component's signed state. */
export const stateField = "effect-views-state"

const sign = (key: Uint8Array, data: string): string =>
  nodeCrypto().createHmac("sha256", key).update(data).digest("base64url")

const seal = (key: Uint8Array, encoded: unknown): string => {
  const data = Buffer.from(JSON.stringify(encoded)).toString("base64url")
  return `${data}.${sign(key, data)}`
}

/** The encoded state, if the signature matches. */
const unseal = (key: Uint8Array, sealed: string): unknown => {
  const [data, signature] = sealed.split(".")
  if (data === undefined || signature === undefined) return undefined
  const expected = Buffer.from(sign(key, data))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !nodeCrypto().timingSafeEqual(expected, actual)) return undefined
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString())
  } catch {
    return undefined
  }
}

// State and payloads decode without services; the casts drop the generic service parameters.
const jsonCodec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
  Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>

const stringTreeCodec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
  Schema.toCodecStringTree(schema) as unknown as Schema.Codec<unknown, unknown>

// Contracts ---------------------------------------------------------------------

/** Where action endpoints, and the code of components that run in the browser, are served. */
export const prefix = "/live"

/**
 * Where a component's state lives and its handlers run. On the server, the
 * state is signed and kept in the page, and each action is a request. In the
 * browser, the state stays in the page, and actions run there.
 */
export type Runs = "server" | "browser"

/**
 * A live component's contract: its tag, its state, its actions, and where it
 * runs. It has no markup and no handlers, so views and handlers can both
 * depend on it.
 */
export interface LiveComponent<
  Tag extends string,
  State,
  Actions extends Record<string, LiveAction.Any>,
  Where extends Runs = "server"
> {
  readonly [TypeId]: typeof TypeId
  readonly tag: Tag
  /** Everything the component renders from. */
  readonly state: Schema.Top
  readonly actions: Actions
  readonly runs: Where
  readonly "~state"?: State
  /** Adds an action to the contract. */
  add<Action extends LiveAction.Any>(
    action: Action
  ): LiveComponent<Tag, State, Actions & { readonly [K in Action["name"]]: Action }, Where>
}

export type Any = LiveComponent<string, any, Record<string, LiveAction.Any>, Runs>

export type StateOf<C> = C extends LiveComponent<any, infer State, any, any> ? State : never

const isCustomElementName = (tag: string): boolean => /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(tag)

/**
 * Declares a live component. Its state is usually a Schema.Class, which is
 * also the state's type. It runs on the server unless `runs` says "browser";
 * the contract says so, rather than the handlers, because the API's endpoints
 * and the view both depend on it.
 *
 * ```ts
 * export class SearchState extends Schema.Class<SearchState>("SearchState")({
 *   query: Schema.String,
 *   matches: Schema.Array(Todo)
 * }) {}
 *
 * export const Search = LiveComponent.make("todo-search", { state: SearchState })
 *   .add(LiveAction.make("search", { payload: { query: Schema.optionalKey(Schema.String) } }))
 * ```
 */
export const make = <const Tag extends string, S extends Schema.Top, const Where extends Runs = "server">(
  tag: Tag,
  options: { readonly state: S; readonly runs?: Where }
): LiveComponent<Tag, S["Type"], {}, Where> => {
  if (!isCustomElementName(tag)) {
    throw new TypeError(`A live component's tag must be a custom element name, such as "app-search": ${tag}`)
  }
  const runs = options.runs ?? "server"
  const build = (actions: Record<string, LiveAction.Any>): Any => ({
    [TypeId]: TypeId,
    tag,
    state: options.state,
    actions,
    runs,
    add: (action) => {
      if (Object.hasOwn(actions, action.name)) {
        throw new TypeError(`<${tag}> already has an action named ${action.name}`)
      }
      return build({ ...actions, [action.name]: action }) as any
    }
  })
  return build({}) as LiveComponent<Tag, S["Type"], {}, Where>
}

// Views -------------------------------------------------------------------------

/**
 * A placeholder fits a field whose encoded form is text or a boolean, such as
 * a number parsed from text or one of several literals; decoding checks it.
 */
type PlaceholderFor<Encoded> = [NonNullable<Encoded>] extends [string] ? On.Placeholder<string>
  : [NonNullable<Encoded>] extends [boolean] ? On.Placeholder<boolean>
  : never

/** An action's values in the browser: each known when rendering, or read when the event happens. */
export type BrowserValues<Payload, Encoded> = {
  readonly [K in keyof Payload]: Payload[K] | PlaceholderFor<K extends keyof Encoded ? Encoded[K] : never>
}

/**
 * What each action gives the view: a command to bind to an event with On. On
 * the server, an action takes values for any of its fields, and the rest come
 * from inputs in the component, by name. In the browser, it takes all of its
 * values, each known when rendering or read when the event happens.
 */
export type Actions<C> = C extends LiveComponent<any, any, infer Defined, infer Where> ? Where extends "browser" ? {
      readonly [Name in keyof Defined]: [keyof LiveAction.Payload<Defined[Name]>] extends [never] ? () => On.Command
        : (values: BrowserValues<LiveAction.Payload<Defined[Name]>, LiveAction.Encoded<Defined[Name]>>) => On.Command
    }
  : {
    readonly [Name in keyof Defined]: [keyof LiveAction.Payload<Defined[Name]>] extends [never] ? () => On.Command
      : (values?: Partial<LiveAction.Payload<Defined[Name]>>) => On.Command
  }
  : never

export interface View<C extends Any> {
  /** Renders the component with a state. */
  (props: { readonly state: StateOf<C> }): Html.Html
  readonly component: C
  /** Renders the component, for the action handlers. */
  readonly render: (state: StateOf<C>) => Html.Html
  /** Renders what goes inside the component's element; in the browser, after each change of state. */
  readonly contents: (state: StateOf<C>) => Html.Html
}

export interface ViewOptions<C extends Any> {
  /** Styles scoped to the component's element; see Component.make. */
  readonly style?: Component.Css
  /** The component's markup, given its state and its actions. */
  readonly render: (state: StateOf<C>, actions: Actions<C>) => Html.Html
}

/** Where a component that runs in the browser loads its code, without Assets.layer: see endpoints. */
const moduleEndpointPath = (tag: string) => `${prefix}/${tag}/module.js`

/** Fails clearly when the page cannot run the component, rather than rendering controls that do nothing. */
const requireRuntime = (tag: string): void => {
  const manifest = Manifest.current()
  if (manifest !== undefined && !manifest.runtime) {
    throw new Error(
      `<${tag}> needs the effect-views runtime; give Assets.layer the API that has the component's endpoints: ` +
        `Assets.layer({ api })`
    )
  }
}

/**
 * The markup of a live component. It needs only the contract, so it renders
 * without the handlers or their services; a component that runs in the
 * browser renders with the same view there, after each change of state.
 *
 * ```tsx
 * export const SearchView = LiveComponent.view(Search, {
 *   render: (state, actions) => (
 *     <input name="query" value={state.query} {...On.input(actions.search())} />
 *   )
 * })
 *
 * <SearchView state={new SearchState({ query: "", matches: [] })} />
 * ```
 */
export const view = <C extends Any>(component: C, options: ViewOptions<C>): View<C> => {
  const encode = Schema.encodeSync(jsonCodec(component.state))
  const style = options.style === undefined ? {} : { style: options.style }

  if (component.runs === "browser") {
    const commandOf = (action: LiveAction.Any) => (values?: Record<string, unknown>): On.Command => {
      const payload: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(values ?? {})) {
        const field = action.payload.fields[key] as Schema.Top | undefined
        if (field === undefined || value === undefined) continue
        payload[key] = On.isPlaceholder(value) ? value : Schema.encodeSync(jsonCodec(field))(value)
      }
      return { _tag: "Action", action: action.name, payload }
    }
    const actions = Object.fromEntries(
      Object.values(component.actions).map((action) => [action.name, commandOf(action)])
    ) as Actions<C>
    const contents = (state: StateOf<C>) => options.render(state, actions)

    const Element = Component.make<StateOf<C>>(component.tag, {
      ...style,
      attributes: (state) => {
        requireRuntime(component.tag)
        return {
          "data-live": "browser",
          "data-live-module": Manifest.current()?.live.get(component.tag)?.module ?? moduleEndpointPath(component.tag),
          "data-live-state": JSON.stringify(encode(state))
        }
      },
      render: contents
    })
    const render = (state: StateOf<C>) => {
      // Fetch the component's modules while the page loads, rather than after the runtime finds the element
      const preloads = Manifest.current()?.live.get(component.tag)?.preloads ?? []
      return Html.fragment(preloads.map((href) => Html.element("link", { rel: "modulepreload", href })), Element(state))
    }
    return Object.assign((props: { readonly state: StateOf<C> }) => render(props.state), { component, render, contents })
  }

  const commandOf = (action: LiveAction.Any) => (values?: Record<string, unknown>): On.Command => {
    const payload: Record<string, string | ReadonlyArray<string>> = {}
    for (const [key, value] of Object.entries(values ?? {})) {
      const field = action.payload.fields[key] as Schema.Top | undefined
      if (field !== undefined && value !== undefined) {
        payload[key] = Schema.encodeSync(stringTreeCodec(field))(value) as string | ReadonlyArray<string>
      }
    }
    return {
      _tag: "Server",
      action: action.name,
      url: `${prefix}/${component.tag}/${action.name}`,
      payload,
      concurrency: action.concurrency,
      ...(action.debounce === undefined ? {} : { debounce: action.debounce })
    }
  }

  const actions = Object.fromEntries(
    Object.values(component.actions).map((action) => [action.name, commandOf(action)])
  ) as Actions<C>

  const contents = (state: StateOf<C>) =>
    Html.fragment(
      Html.element("input", { type: "hidden", name: stateField, value: seal(currentKey(), encode(state)) }),
      options.render(state, actions)
    )
  const Element = Component.make<StateOf<C>>(component.tag, {
    ...style,
    attributes: () => {
      requireRuntime(component.tag)
      return { "data-live": "server" }
    },
    render: contents
  })

  const render = (props: { readonly state: StateOf<C> }) => Element(props.state)
  return Object.assign(render, { component, render: Element, contents })
}

// Handlers ----------------------------------------------------------------------

type ServerComponent = LiveComponent<string, any, Record<string, LiveAction.Any>, "server">
type BrowserComponent = LiveComponent<string, any, Record<string, LiveAction.Any>, "browser">

/** A handler for each action: the next state, given the state and the action's payload. */
export type Implementation<C> = C extends LiveComponent<any, infer State, infer Defined, any> ? {
    readonly [Name in keyof Defined]: (
      state: State,
      payload: LiveAction.Payload<Defined[Name]>
    ) => Effect.Effect<State, never, any>
  }
  : never

type ContextOf<Impl> = {
  [Name in keyof Impl]: Impl[Name] extends (...args: any) => Effect.Effect<any, any, infer R> ? R : never
}[keyof Impl]

/** A component's handlers, as provided by LiveComponent.server or LiveComponent.browser. */
export interface Handlers<Tag extends string> {
  readonly tag: Tag
  readonly view: View<Any>
  readonly implementation: Readonly<Record<string, (state: unknown, payload: unknown) => Effect.Effect<unknown>>>
  readonly context: Context.Context<never>
}

/** The service holding a component's handlers. */
const HandlersKey = <Tag extends string>(tag: Tag): Context.Key<Handlers<Tag>, Handlers<Tag>> =>
  Context.Service<Handlers<Tag>>(`effect-views/LiveComponent/Handlers/${tag}`) as any

/**
 * Implements the actions of a component that runs on the server, as a layer
 * that handle uses. Every action needs a handler, which returns the next
 * state; a problem to show the user belongs in the state. The handlers'
 * services are taken when the layer is built, so provide them to it.
 *
 * ```ts
 * export const SearchHandlers = LiveComponent.server(SearchView, {
 *   search: (_state, { query = "" }) =>
 *     Effect.gen(function* () {
 *       const todos = yield* Todos
 *       return new SearchState({ query, matches: yield* todos.search(query) })
 *     })
 * }).pipe(Layer.provide(Todos.layer))
 * ```
 */
export const server = <C extends ServerComponent, const Impl extends Implementation<C>>(
  view: View<C>,
  implementation: Impl
): Layer.Layer<Handlers<C["tag"]>, never, ContextOf<Impl>> =>
  Layer.effect(
    HandlersKey(view.component.tag),
    Effect.map(Effect.context<ContextOf<Impl>>(), (context) => ({
      tag: view.component.tag,
      view: view as unknown as View<Any>,
      implementation: implementation as unknown as Handlers<C["tag"]>["implementation"],
      context: context as Context.Context<never>
    }))
  ) as any

/** The state of a component that runs in the browser, which its handlers read and change. */
export interface StateRef<A> {
  readonly get: Effect.Effect<A>
  readonly set: (state: A) => Effect.Effect<void>
  readonly update: (f: (state: A) => A) => Effect.Effect<void>
}

/**
 * A handler for each action of a component that runs in the browser. Handlers
 * change the state rather than returning it: in the browser actions overlap,
 * such as a key press while a search waits for results, and a handler may
 * change the state more than once.
 */
export type BrowserImplementation<C, R = any> = C extends LiveComponent<any, infer State, infer Defined, any> ? {
    readonly [Name in keyof Defined]: (
      state: StateRef<State>,
      payload: LiveAction.Payload<Defined[Name]>
    ) => Effect.Effect<void, never, R>
  }
  : never

/** @internal What LiveComponent.browser records, for Assets.layer on the server and the runtime in the browser. */
export interface BrowserDefinition {
  readonly component: Any
  readonly view: View<Any>
  readonly implementation: Readonly<Record<string, (state: StateRef<unknown>, payload: unknown) => Effect.Effect<void>>>
  readonly layer: Layer.Layer<any, any, any> | undefined
  /** The file that called LiveComponent.browser: the module the browser loads. */
  readonly file: string | undefined
}

// Shared by every copy of this module in the page, such as one from source and one compiled, so that the
// runtime finds handlers registered by either
const browserDefinitions: Map<string, BrowserDefinition> =
  ((globalThis as any)[Symbol.for("effect-views/LiveComponent/browserDefinitions")] ??= new Map())

/** @internal The browser handlers defined for a tag, if their module has been loaded. */
export const browserDefinition = (tag: string): BrowserDefinition | undefined => browserDefinitions.get(tag)

/** The file of the module that called `fn`, from the call stack; only Node's is needed. */
const callerFile = (fn: Function): string | undefined => {
  if (typeof Error.captureStackTrace !== "function") return undefined
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 1
  const holder: { stack?: string } = {}
  Error.captureStackTrace(holder, fn)
  Error.stackTraceLimit = limit
  const frame = holder.stack?.split("\n")[1]?.trim() ?? ""
  const location = /\(([^()]+):\d+:\d+\)$/.exec(frame)?.[1] ?? /^at ([^()]+):\d+:\d+$/.exec(frame)?.[1]
  if (location === undefined) return undefined
  return location.startsWith("file://") ? decodeURIComponent(new URL(location).pathname) : location
}

export interface BrowserOptions<R> {
  /** Services for the handlers, built once per page in the browser and shared by its components. */
  readonly layer: Layer.Layer<R, unknown>
}

/**
 * Implements the actions of a component that runs in the browser. Call it at
 * the top of a module of its own, which imports only what the browser can
 * run: effect-views bundles that module, the file this is called from, for
 * the browser when Assets.layer is built. On the server, the layer it returns
 * lets handle serve the component, so provide it like a server component's.
 *
 * ```ts
 * // AssigneePicker.browser.ts
 * export const PickerHandlers = LiveComponent.browser(PickerView, {
 *   move: (state, { by }) => state.update((s) => new PickerState({ ...s, active: s.active + by }))
 * })
 * ```
 */
export const browser: {
  <C extends BrowserComponent, const Impl extends BrowserImplementation<C, never>>(
    view: View<C>,
    implementation: Impl
  ): Layer.Layer<Handlers<C["tag"]>>
  <C extends BrowserComponent, R, const Impl extends BrowserImplementation<C, R>>(
    view: View<C>,
    implementation: Impl,
    options: BrowserOptions<R>
  ): Layer.Layer<Handlers<C["tag"]>>
} = (view: View<Any>, implementation: object, options?: BrowserOptions<unknown>): Layer.Layer<any> => {
  const tag = view.component.tag
  if (browserDefinitions.has(tag)) throw new TypeError(`<${tag}> already has browser handlers`)
  browserDefinitions.set(tag, {
    component: view.component,
    view,
    implementation: implementation as BrowserDefinition["implementation"],
    layer: options?.layer as BrowserDefinition["layer"],
    file: callerFile(browser)
  })
  return Layer.succeed(HandlersKey(tag))({ tag, view, implementation: {}, context: Context.empty() })
}

// Endpoints ---------------------------------------------------------------------

const stateSchema = /*#__PURE__*/ Schema.String.annotate({
  description: "The component's state, encoded and signed when it was rendered"
})

const endpointOf = <const Tag extends string, const Name extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  name: Name,
  fields: Fields,
  description: string | undefined
) => {
  const endpoint = HttpFormEndpoint.make(
    `${tag}.${name}` as `${Tag}.${Name}`,
    `${prefix}/${tag}/${name}` as `/live/${Tag}/${Name}`,
    {
      payload: Schema.Struct({ ...fields, [stateField]: stateSchema } as Fields & { readonly [stateField]: Schema.String }),
      annotations: OpenApi.annotations({
        ...(description === undefined ? {} : { summary: description }),
        // Markdown: backticks keep the tag from being read as HTML
        description: `An action of the \`<${tag}>\` live component. The effect-views runtime sends the ` +
          `component's signed state, in the \`${stateField}\` field, with the inputs in the component, and ` +
          `updates the component with the HTML returned.`,
        // A label beside the operation in Scalar's reference
        override: { "x-badges": [{ name: "Live", position: "before" }] }
      })
    }
  )
  return endpoint.annotate(Endpoint, { tag, runs: "server" })
}

/** Marks a live component's endpoints, so that Assets.layer finds the component in the API. */
export class Endpoint extends /*#__PURE__*/ Context.Service<Endpoint, { readonly tag: string; readonly runs: Runs }>()(
  "effect-views/LiveComponent/Endpoint"
) {}

const JavaScript = /*#__PURE__*/ Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/javascript; charset=utf-8" })
)

const moduleEndpointOf = <const Tag extends string>(tag: Tag) =>
  HttpApiEndpoint.get(`${tag}.module`, `/live/${tag}/module.js`, { success: JavaScript })
    .annotate(Endpoint, { tag, runs: "browser" })
    .annotate(OpenApi.Description, `The code of the \`<${tag}>\` live component, which runs in the browser.`)

type ActionFields<Action> = Action extends LiveAction.LiveAction<any, infer Fields> ? Fields : never

/** The HttpApi endpoints of a component; see endpoints. */
export type Endpoints<C> = C extends LiveComponent<infer Tag, any, infer Defined, infer Where>
  ? Where extends "browser" ? ReturnType<typeof moduleEndpointOf<Tag>>
  : {
    [Name in keyof Defined & string]: ReturnType<typeof endpointOf<Tag, Name, ActionFields<Defined[Name]>>>
  }[keyof Defined & string]
  : never

/**
 * A component's HttpApi endpoints. Add them to the group of the views the
 * component appears in, so that the group's middleware, such as
 * authentication, applies to them, and the OpenAPI document lists them with
 * those views. Implement them with handle.
 *
 * On the server, there is one for each action: a URL-encoded POST to
 * `/live/<tag>/<action>` that responds with HTML. In the browser, there is
 * one GET of `/live/<tag>/module.js`, the component's code; it is also how
 * Assets.layer finds the components to bundle in the API.
 *
 * ```ts
 * export const group = HttpApiGroup.make("todosViews")
 *   .add(list, create)
 *   .add(...LiveComponent.endpoints(Search))
 * ```
 *
 * Do not prefix the group or its API: views render the URLs as above.
 */
export const endpoints = <C extends Any>(component: C): readonly [Endpoints<C>, ...Array<Endpoints<C>>] => {
  if (component.runs === "browser") return [moduleEndpointOf(component.tag)] as any
  const actions = Object.values(component.actions)
  if (actions.length === 0) throw new TypeError(`<${component.tag}> has no actions`)
  return actions.map((action) =>
    endpointOf(component.tag, action.name, action.payload.fields, action.description)
  ) as unknown as readonly [Endpoints<C>, ...Array<Endpoints<C>>]
}

type Identifiers<C> = C extends LiveComponent<infer Tag, any, infer Defined, infer Where>
  ? Where extends "browser" ? `${Tag}.module` : `${Tag}.${keyof Defined & string}`
  : never

const badRequest = (message: string) => HttpServerResponse.text(message, { status: 400 })

type HandlersOf<C> = C extends Any ? Handlers<C["tag"]> : never

/** Adds the handlers of one component's endpoints. */
const handleOne = (component: Any, service: Handlers<string>, handlers: any): any => {
  const { context, implementation, view } = service
  if (component.runs === "browser") {
    return handlers.handle(`${component.tag}.module`, () =>
      Effect.sync(() => {
        const module = Manifest.current()?.live.get(component.tag)?.module
        if (module === undefined) {
          return HttpServerResponse.text(`<${component.tag}> runs in the browser, but Assets.layer was not given the API`, {
            status: 404
          })
        }
        // A stable address for code whose own address changes with its contents
        return `import ${JSON.stringify(module)}\n`
      }))
  }
  const decodeState = Schema.decodeUnknownExit(jsonCodec(component.state))
  let result = handlers
  for (const action of Object.values(component.actions)) {
    const run = implementation[action.name]!
    result = result.handle(
      `${component.tag}.${action.name}`,
      ({ payload }: { payload: Exit.Exit<Record<string, unknown>> }) =>
        Effect.gen(function* () {
          if (Exit.isFailure(payload)) return badRequest("The action's state or values are not valid")
          const { [stateField]: sealed, ...values } = payload.value
          const encoded = typeof sealed === "string" ? unseal(yield* Secret, sealed) : undefined
          if (encoded === undefined) return badRequest("The component's state is missing or was changed")
          const state = decodeState(encoded)
          if (Exit.isFailure(state)) return badRequest("The component's state no longer matches; reload the page")
          return view.render(yield* run(state.value, values).pipe(Effect.provideContext(context)))
        })
    )
  }
  return result
}

/**
 * Handles components' endpoints in the group they were added to, with the
 * handlers from LiveComponent.server or LiveComponent.browser, which the
 * group's layer then requires.
 *
 * On the server, each action responds with the component rendered again, or
 * 400 when its state or payload cannot be decoded, such as state from an
 * older version of the page. In the browser, the component's code is served.
 *
 * ```ts
 * export const TodosViewsLayer = HttpApiBuilder.group(Api, "todosViews", (handlers) =>
 *   handlers
 *     .handle("list", …)
 *     .handle("create", …)
 *     .pipe(LiveComponent.handle(Search, TitleField))
 * ).pipe(Layer.provide([SearchHandlers, TitleFieldHandlers]))
 * ```
 */
export const handle = <const Components extends readonly [Any, ...Array<Any>]>(...components: Components) =>
<R, ByIdentifier extends Record<string, HttpApiEndpoint.Constraint>, Handled extends keyof ByIdentifier>(
  handlers: HttpApiBuilder.Handlers<R, ByIdentifier, Handled>
): Effect.Effect<
  HttpApiBuilder.Handlers<R, ByIdentifier, Handled | (Identifiers<Components[number]> & keyof ByIdentifier)>,
  never,
  HandlersOf<Components[number]>
> =>
  Effect.gen(function* () {
    let result: any = handlers
    for (const component of components) {
      result = handleOne(component, yield* HandlersKey(component.tag), result)
    }
    return result
  }) as any
