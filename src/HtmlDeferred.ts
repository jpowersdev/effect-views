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

/** The params and query props required by an endpoint, typed by its schemas. */
export type Request<Endpoint extends EndpointLike> =
  & RequestPart<"params", HttpApiEndpoint.Params<Endpoint>["Type"]>
  & RequestPart<"query", HttpApiEndpoint.Query<Endpoint>["Type"]>

type NativeAttributes = Omit<Html.Attributes, "children" | "params" | "query"> & {
  readonly "hx-get"?: never
  readonly "hx-trigger"?: never
  readonly "hx-swap"?: never
}

export type Props<Endpoint extends EndpointLike> = NativeAttributes & Request<Endpoint> & {
  /** Shown until the fragment arrives, and kept if it never does. */
  readonly children?: Html.Child
  /** An htmx trigger such as "load" (the default), "revealed", or "every 30s". */
  readonly trigger?: string
  /** An htmx swap strategy. Defaults to "outerHTML", replacing the placeholder. */
  readonly swap?: string
}

export interface DeriveConfig<Endpoint extends EndpointLike> {
  readonly endpoint: Endpoint
  /** The placeholder element. Defaults to "div". */
  readonly element?: string
}

export interface HtmlDeferred<Endpoint extends EndpointLike> {
  readonly endpoint: Endpoint
  /** Builds the fragment URL, encoding params and query with the endpoint's schemas. */
  readonly url: (request: Request<Endpoint>) => string
  readonly Root: (props: Props<Endpoint>) => Html.Html
}

/**
 * Renders a placeholder that htmx replaces with a GET view endpoint's response.
 * Params and query are typed and encoded by the endpoint's schemas, as the
 * server decodes them. The fragment only loads when JavaScript is available.
 */
export const derive = <const Endpoint extends EndpointLike>(
  config: DeriveConfig<Endpoint>
): HtmlDeferred<Endpoint> => {
  const { element = "div", endpoint } = config
  const api = HttpApi.make("effect-views/HtmlDeferred").add(
    HttpApiGroup.make("deferred", { topLevel: true }).add(endpoint as any)
  )
  const builder = HttpApiClient.urlBuilder(api) as unknown as Record<string, (request: unknown) => string>
  const build = builder[endpoint.identifier]!

  const url = (request: Request<Endpoint>): string => build(request)

  const Root = (props: Props<Endpoint>): Html.Html => {
    const { children, params, query, swap = "outerHTML", trigger = "load", ...attributes } = props as Props<Endpoint> & {
      readonly params?: unknown
      readonly query?: unknown
    }
    return Html.element(element, {
      ...attributes,
      "hx-get": build({ params, query }),
      "hx-trigger": trigger,
      "hx-swap": swap,
      children
    })
  }

  return Object.freeze({ endpoint, url, Root })
}
