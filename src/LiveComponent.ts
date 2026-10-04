import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as OpenApi from "effect/http-api/OpenApi"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import * as Component from "./Component.js"
import * as Html from "./Html.js"
import * as HttpFormEndpoint from "./HttpFormEndpoint.js"
import type * as LiveAction from "./LiveAction.js"

export const TypeId = "~effect-views/LiveComponent" as const

// Signing -----------------------------------------------------------------------

let defaultKey: Uint8Array | undefined

/**
 * The key that signs live components' state. By default it is chosen at
 * random when first used, so pages rendered before a restart, or by another
 * server, stop accepting actions. Provide `LiveComponent.secret(...)` to share one.
 */
export const Secret = Context.Reference<Uint8Array>("effect-views/LiveComponent/Secret", {
  defaultValue: () => defaultKey ??= randomBytes(32)
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

const sign = (key: Uint8Array, data: string): string => createHmac("sha256", key).update(data).digest("base64url")

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
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
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

/** Where action endpoints are served. */
export const prefix = "/live"

/**
 * A live component's contract: its tag, its state, and its actions. It has no
 * markup and no handlers, so views and handlers can both depend on it.
 */
export interface LiveComponent<Tag extends string, State, Actions extends Record<string, LiveAction.Any>> {
  readonly [TypeId]: typeof TypeId
  readonly tag: Tag
  /** Everything the component renders from. It is signed and kept in the page between actions. */
  readonly state: Schema.Top
  readonly actions: Actions
  readonly "~state"?: State
  /** Adds an action to the contract. */
  add<Action extends LiveAction.Any>(
    action: Action
  ): LiveComponent<Tag, State, Actions & { readonly [K in Action["name"]]: Action }>
}

export type Any = LiveComponent<string, any, Record<string, LiveAction.Any>>

export type StateOf<C> = C extends LiveComponent<any, infer State, any> ? State : never

const isCustomElementName = (tag: string): boolean => /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(tag)

/**
 * Declares a live component. Its state is usually a Schema.Class, which is
 * also the state's type.
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
export const make = <const Tag extends string, S extends Schema.Top>(
  tag: Tag,
  options: { readonly state: S }
): LiveComponent<Tag, S["Type"], {}> => {
  if (!isCustomElementName(tag)) {
    throw new TypeError(`A live component's tag must be a custom element name, such as "app-search": ${tag}`)
  }
  const build = (actions: Record<string, LiveAction.Any>): Any => ({
    [TypeId]: TypeId,
    tag,
    state: options.state,
    actions,
    add: (action) => {
      if (Object.hasOwn(actions, action.name)) {
        throw new TypeError(`<${tag}> already has an action named ${action.name}`)
      }
      return build({ ...actions, [action.name]: action }) as any
    }
  })
  return build({}) as LiveComponent<Tag, S["Type"], {}>
}

// Views -------------------------------------------------------------------------

/** Attributes that send an action with htmx: spread them onto a button, input, or form. */
export interface ActionAttributes {
  readonly "hx-post": string
  readonly "hx-include": string
  readonly "hx-target": string
  readonly "hx-swap": string
  readonly "hx-vals"?: string
}

/**
 * The attributes for each action. An action with a payload takes values for
 * any of its fields; the rest come from inputs in the component, by name.
 */
export type Actions<C> = C extends LiveComponent<any, any, infer Defined> ? {
    readonly [Name in keyof Defined]: [keyof LiveAction.Payload<Defined[Name]>] extends [never]
      ? () => ActionAttributes
      : (values?: Partial<LiveAction.Payload<Defined[Name]>>) => ActionAttributes
  }
  : never

export interface View<C extends Any> {
  /** Renders the component with a state. */
  (props: { readonly state: StateOf<C> }): Html.Html
  readonly component: C
  /** Renders the component, for the action handlers. */
  readonly render: (state: StateOf<C>) => Html.Html
}

export interface ViewOptions<C extends Any> {
  /** Styles scoped to the component's element; see Component.make. */
  readonly style?: Component.Css
  /** The component's markup, given its state and its actions' attributes. */
  readonly render: (state: StateOf<C>, actions: Actions<C>) => Html.Html
}

/**
 * The markup of a live component. It needs only the contract, so it renders
 * without the handlers or their services.
 *
 * ```tsx
 * export const SearchView = LiveComponent.view(Search, {
 *   render: (state, actions) => (
 *     <input name="query" value={state.query} {...actions.search()} hx-trigger="input changed delay:200ms" />
 *   )
 * })
 *
 * <SearchView state={new SearchState({ query: "", matches: [] })} />
 * ```
 */
export const view = <C extends Any>(component: C, options: ViewOptions<C>): View<C> => {
  const encode = Schema.encodeSync(jsonCodec(component.state))
  const target = `closest ${component.tag}`

  const attributesOf = (action: LiveAction.Any) => (values?: Record<string, unknown>): ActionAttributes => {
    const attributes = {
      "hx-post": `${prefix}/${component.tag}/${action.name}`,
      "hx-include": target,
      "hx-target": target,
      "hx-swap": "outerHTML"
    }
    if (values === undefined) return attributes
    const encoded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      const field = action.payload.fields[key] as Schema.Top | undefined
      if (field !== undefined && value !== undefined) encoded[key] = Schema.encodeSync(stringTreeCodec(field))(value)
    }
    return { ...attributes, "hx-vals": JSON.stringify(encoded) }
  }

  const actions = Object.fromEntries(
    Object.values(component.actions).map((action) => [action.name, attributesOf(action)])
  ) as Actions<C>

  const Element = Component.make<StateOf<C>>(component.tag, {
    ...(options.style === undefined ? {} : { style: options.style }),
    render: (state) =>
      Html.fragment(
        Html.element("input", { type: "hidden", name: stateField, value: seal(currentKey(), encode(state)) }),
        options.render(state, actions)
      )
  })

  const render = (props: { readonly state: StateOf<C> }) => Element(props.state)
  return Object.assign(render, { component, render: Element })
}

// Handlers ----------------------------------------------------------------------

/** A handler for each action: the next state, given the state and the action's payload. */
export type Implementation<C> = C extends LiveComponent<any, infer State, infer Defined> ? {
    readonly [Name in keyof Defined]: (
      state: State,
      payload: LiveAction.Payload<Defined[Name]>
    ) => Effect.Effect<State, never, any>
  }
  : never

type ContextOf<Impl> = {
  [Name in keyof Impl]: Impl[Name] extends (...args: any) => Effect.Effect<any, any, infer R> ? R : never
}[keyof Impl]

/** A component's handlers, with the services they use, as provided by LiveComponent.handlers. */
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
 * Implements a component's actions, as a layer that handle uses.
 * Every action needs a handler, which returns the next state; a problem to
 * show the user belongs in the state. The handlers' services are taken when
 * the layer is built, so provide them to it.
 *
 * ```ts
 * export const SearchHandlers = LiveComponent.handlers(SearchView, {
 *   search: (_state, { query = "" }) =>
 *     Effect.gen(function* () {
 *       const todos = yield* Todos
 *       return new SearchState({ query, matches: yield* todos.search(query) })
 *     })
 * }).pipe(Layer.provide(Todos.layer))
 * ```
 */
export const handlers = <C extends Any, const Impl extends Implementation<C>>(
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

// Endpoints ---------------------------------------------------------------------

const stateSchema = Schema.String.annotate({
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
        description: `An action of the \`<${tag}>\` live component. htmx sends the component's signed state, ` +
          `in the \`${stateField}\` field, with the inputs in the component, and swaps in the HTML returned.`,
        // A label beside the operation in Scalar's reference
        override: { "x-badges": [{ name: "Live", position: "before" }] }
      })
    }
  )
  return endpoint
}

type ActionFields<Action> = Action extends LiveAction.LiveAction<any, infer Fields> ? Fields : never

/** The HttpApi endpoints of a component's actions; see endpoints. */
export type Endpoints<C> = C extends LiveComponent<infer Tag, any, infer Defined> ? {
    [Name in keyof Defined & string]: ReturnType<typeof endpointOf<Tag, Name, ActionFields<Defined[Name]>>>
  }[keyof Defined & string]
  : never

/**
 * An HttpApi endpoint for each of a component's actions: a URL-encoded POST
 * to `/live/<tag>/<action>` that responds with HTML. Add them to the group of
 * the views the component appears in, so that the group's middleware, such as
 * authentication, applies to them, and the OpenAPI document lists them with
 * those views. Implement them with handle.
 *
 * ```ts
 * export const group = HttpApiGroup.make("todosViews")
 *   .add(list, create)
 *   .add(...LiveComponent.endpoints(Search))
 * ```
 *
 * Do not prefix the group or its API: views render the action URLs as above.
 */
export const endpoints = <C extends Any>(component: C): readonly [Endpoints<C>, ...Array<Endpoints<C>>] => {
  const actions = Object.values(component.actions)
  if (actions.length === 0) throw new TypeError(`<${component.tag}> has no actions`)
  return actions.map((action) =>
    endpointOf(component.tag, action.name, action.payload.fields, action.description)
  ) as unknown as readonly [Endpoints<C>, ...Array<Endpoints<C>>]
}

type Identifiers<C> = C extends LiveComponent<infer Tag, any, infer Defined> ? `${Tag}.${keyof Defined & string}` : never

const badRequest = (message: string) => HttpServerResponse.text(message, { status: 400 })

/**
 * Handles a component's actions in the group its endpoints were added to, with
 * the handlers from LiveComponent.handlers, which the group's layer then
 * requires. Each action responds with the component rendered again, or 400
 * when its state or payload cannot be decoded, such as state from an older
 * version of the page.
 *
 * ```ts
 * export const TodosViewsLayer = HttpApiBuilder.group(Api, "todosViews", (handlers) =>
 *   handlers
 *     .handle("list", …)
 *     .handle("create", …)
 *     .pipe(LiveComponent.handle(Search))
 * ).pipe(Layer.provide(SearchHandlers))
 * ```
 */
export const handle = <C extends Any>(component: C) =>
<R, ByIdentifier extends Record<string, HttpApiEndpoint.Constraint>, Handled extends keyof ByIdentifier>(
  handlers: HttpApiBuilder.Handlers<R, ByIdentifier, Handled>
): Effect.Effect<
  HttpApiBuilder.Handlers<R, ByIdentifier, Handled | (Identifiers<C> & keyof ByIdentifier)>,
  never,
  Handlers<C["tag"]>
> =>
  Effect.map(HandlersKey(component.tag), ({ context, implementation, view }) => {
    const decodeState = Schema.decodeUnknownExit(jsonCodec(component.state))
    let result: any = handlers
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
  })
