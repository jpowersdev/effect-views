import * as Duration from "effect/Duration"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"

import * as Html from "./Html.js"
import * as Protocol from "./internal/Protocol.js"

export interface EndpointLike extends HttpApiEndpoint.ConstraintRequest {
  readonly method: "GET"
  readonly path: string
}

type RequestPart<Key extends string, Value> = [Value] extends [never] ? {} : {
  readonly [K in Key]: Value
}

/** The params and query a view endpoint requires, typed by its schemas. */
export type Request<Endpoint extends EndpointLike> =
  & RequestPart<"params", HttpApiEndpoint.Params<Endpoint>["Type"]>
  & RequestPart<"query", HttpApiEndpoint.Query<Endpoint>["Type"]>

/** No argument is needed for an endpoint without params or query. */
type RequestArgs<Endpoint extends EndpointLike> = keyof Request<Endpoint> extends never
  ? [request?: Request<Endpoint>]
  : [request: Request<Endpoint>]

type NativeAttributes<Reserved extends string> =
  & Omit<Html.Attributes, "children" | "params" | "query">
  & { readonly [Name in Reserved]?: never }

export type LinkProps<Endpoint extends EndpointLike> = NativeAttributes<"href"> & Request<Endpoint> & {
  readonly children?: Html.Child
}

export type LazyProps<Endpoint extends EndpointLike> =
  & NativeAttributes<typeof Protocol.loadAttribute>
  & Request<Endpoint>
  & {
    /** The placeholder element. Defaults to "div". */
    readonly as?: string
    /** Shown until the view arrives, and kept if it never does. */
    readonly children?: Html.Child
    /**
     * When to load the view: "load" (the default) once the page has loaded,
     * "visible" once the placeholder scrolls into view, or `{ every: "30
     * seconds" }` again and again.
     */
    readonly trigger?: "load" | "visible" | { readonly every: Duration.Input }
    /** "outer" (the default) replaces the placeholder with the view; "inner" replaces what it contains. */
    readonly swap?: "outer" | "inner"
  }

export type SubscribeProps<Endpoint extends EndpointLike> =
  & NativeAttributes<typeof Protocol.subscribeAttribute>
  & Request<Endpoint>
  & {
    /** The event whose HTML replaces the element's contents, or several. */
    readonly event: string | ReadonlyArray<string>
    /** "inner" (the default) replaces the element's contents with each event; "append" adds each after them. */
    readonly swap?: "inner" | "append"
    /** The element. Defaults to "div". */
    readonly as?: string
    /** Shown until the first event arrives, and kept if none does. */
    readonly children?: Html.Child
  }

export type ConnectProps<Endpoint extends EndpointLike> =
  & NativeAttributes<typeof Protocol.subscribeAttribute | typeof Protocol.eventAttribute>
  & Request<Endpoint>
  & {
    /** The element. Defaults to "div". */
    readonly as?: string
    /** What it contains: elements given `event(name)` take the events they name. */
    readonly children?: Html.Child
  }

export interface DeriveConfig<Endpoint extends EndpointLike> {
  readonly endpoint: Endpoint
}

export interface View<Endpoint extends EndpointLike> {
  readonly endpoint: Endpoint
  /** The view's URL, with params and query encoded by the endpoint's schemas. */
  readonly url: (...args: RequestArgs<Endpoint>) => string
  /** A link to the view. */
  readonly Link: (props: LinkProps<Endpoint>) => Html.Html
  /**
   * A placeholder that the effect-views runtime replaces with the view once
   * the page has loaded, or when its trigger says. It only loads when
   * JavaScript is available.
   */
  readonly Lazy: (props: LazyProps<Endpoint>) => Html.Html
  /**
   * An element whose contents the effect-views runtime replaces with the HTML
   * of each event the view streams, for endpoints declared with
   * HttpViewEndpoint.events.
   */
  readonly Subscribe: (props: SubscribeProps<Endpoint>) => Html.Html
  /**
   * An element that opens one connection to the view's stream, for elements
   * inside it that take different events, each given `event(name)`. Use it
   * rather than several Subscribes to the same stream.
   */
  readonly Connect: (props: ConnectProps<Endpoint>) => Html.Html
  /** Attributes for an element inside a Connect: the event, by name, whose HTML replaces what it contains. */
  readonly event: (name: string) => { readonly [Protocol.eventAttribute]: string }
}

/**
 * Derives typed links and lazy placeholders from a GET view endpoint. Params
 * and query are checked against the endpoint's schemas, and encoded as the
 * server decodes them.
 */
export const derive = <const Endpoint extends EndpointLike>(config: DeriveConfig<Endpoint>): View<Endpoint> => {
  const { endpoint } = config
  const api = HttpApi.make("effect-views/View").add(
    HttpApiGroup.make("view", { topLevel: true }).add(endpoint as any)
  )
  const builder = HttpApiClient.urlBuilder(api) as unknown as Record<string, (request: unknown) => string>
  const build = builder[endpoint.identifier]!

  type WithRequest = { readonly params?: unknown; readonly query?: unknown }

  const url = (...[request]: RequestArgs<Endpoint>): string => build(request ?? {})

  const Link = (props: LinkProps<Endpoint>): Html.Html => {
    const { children, params, query, ...attributes } = props as LinkProps<Endpoint> & WithRequest
    return Html.element("a", { href: build({ params, query }), ...attributes, children })
  }

  const Lazy = (props: LazyProps<Endpoint>): Html.Html => {
    const { as = "div", children, params, query, swap = "outer", trigger = "load", ...attributes } =
      props as LazyProps<Endpoint> & WithRequest
    const load: Protocol.Load = {
      url: build({ params, query }),
      when: typeof trigger === "string" ? trigger : { every: Duration.toMillis(trigger.every) },
      swap
    }
    return Html.element(as, { ...attributes, [Protocol.loadAttribute]: JSON.stringify(load), children })
  }

  const Subscribe = (props: SubscribeProps<Endpoint>): Html.Html => {
    const { as = "div", children, event, params, query, swap = "inner", ...attributes } =
      props as SubscribeProps<Endpoint> & WithRequest
    const subscription: Protocol.Subscription = {
      url: build({ params, query }),
      events: typeof event === "string" ? [event] : event,
      swap
    }
    return Html.element(as, { ...attributes, [Protocol.subscribeAttribute]: JSON.stringify(subscription), children })
  }

  const Connect = (props: ConnectProps<Endpoint>): Html.Html => {
    const { as = "div", children, params, query, ...attributes } = props as ConnectProps<Endpoint> & WithRequest
    const subscription: Protocol.Subscription = { url: build({ params, query }), swap: "inner" }
    return Html.element(as, { ...attributes, [Protocol.subscribeAttribute]: JSON.stringify(subscription), children })
  }

  const event = (name: string) => ({ [Protocol.eventAttribute]: name }) as { readonly [Protocol.eventAttribute]: string }

  return Object.freeze({ endpoint, url, Link, Lazy, Subscribe, Connect, event })
}
