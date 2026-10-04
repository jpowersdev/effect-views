import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"

import * as Html from "./Html.js"

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
  & NativeAttributes<"hx-get" | "hx-trigger" | "hx-swap">
  & Request<Endpoint>
  & {
    /** The placeholder element. Defaults to "div". */
    readonly as?: string
    /** Shown until the view arrives, and kept if it never does. */
    readonly children?: Html.Child
    /** An htmx trigger such as "load" (the default), "revealed", or "every 30s". */
    readonly trigger?: string
    /** An htmx swap strategy. Defaults to "outerHTML", replacing the placeholder. */
    readonly swap?: string
  }

export type SubscribeProps<Endpoint extends EndpointLike> =
  & NativeAttributes<"hx-ext" | "sse-connect" | "sse-swap">
  & Request<Endpoint>
  & {
    /** The name of the events whose HTML replaces the element's contents, or several, separated by commas. */
    readonly event: string
    /** The element. Defaults to "div". */
    readonly as?: string
    /** Shown until the first event arrives, and kept if none does. */
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
   * A placeholder that htmx replaces with the view once the page has loaded, or
   * when its trigger fires. It only loads when JavaScript is available.
   */
  readonly Lazy: (props: LazyProps<Endpoint>) => Html.Html
  /**
   * An element whose contents htmx replaces with the HTML of each event the
   * view streams, for endpoints declared with HttpViewEndpoint.events. It
   * needs htmx's sse extension; see Assets.Options.
   */
  readonly Subscribe: (props: SubscribeProps<Endpoint>) => Html.Html
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
    const { as = "div", children, params, query, swap = "outerHTML", trigger = "load", ...attributes } =
      props as LazyProps<Endpoint> & WithRequest
    return Html.element(as, {
      ...attributes,
      "hx-get": build({ params, query }),
      "hx-trigger": trigger,
      "hx-swap": swap,
      children
    })
  }

  const Subscribe = (props: SubscribeProps<Endpoint>): Html.Html => {
    const { as = "div", children, event, params, query, ...attributes } =
      props as SubscribeProps<Endpoint> & WithRequest
    return Html.element(as, {
      ...attributes,
      "hx-ext": "sse",
      "sse-connect": build({ params, query }),
      "sse-swap": event,
      children
    })
  }

  return Object.freeze({ endpoint, url, Link, Lazy, Subscribe })
}
