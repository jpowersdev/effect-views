/**
 * Pages and fragments: the same handlers serve a whole page to the browser,
 * and just the view to the effect-views runtime, when it submits a form or
 * loads a placeholder and puts the response into the page. The headers here
 * tell the runtime what to do with a response; see Protocol.
 */
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import * as Html from "./Html.js"
import * as Protocol from "./internal/Protocol.js"

export type { Swap } from "./internal/Protocol.js"

/**
 * Whether to respond with just a fragment: the effect-views runtime made the
 * request, to put the response into the page. Ordinary requests, such as
 * links and forms without JavaScript, expect a whole page.
 */
export const wantsFragment = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers[Protocol.requestHeader]?.toLowerCase() === "true"

export interface LayoutOptions {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
}

export interface Layout {
  (request: HttpServerRequest.HttpServerRequest, view: Html.Html): Html.Html
  (request: HttpServerRequest.HttpServerRequest, view: Html.Html, options: LayoutOptions): HttpServerResponse.HttpServerResponse
}

/**
 * Responds with a view on its own to the runtime, or inside a page for
 * everything else. Pass options to set the status, such as 404, or 422 for a
 * form returned with its errors, which the runtime puts into the page too.
 *
 * ```tsx
 * const page = Page.layout(Document)
 * page(request, <OrderView order={order} />)
 * page(request, <NotFound />, { status: 404 })
 * ```
 */
export const layout = (
  Document: (props: { readonly children: Html.Child }) => Html.Html
): Layout =>
  ((request: HttpServerRequest.HttpServerRequest, view: Html.Html, options?: LayoutOptions) => {
    const html = wantsFragment(request) ? view : Document({ children: view })
    return options === undefined ? html : Html.response(html, options)
  }) as Layout

const appendVary = (current: string | undefined, value: string): string => {
  if (current === undefined || current.trim() === "") return value
  const values = current.split(",").map((item) => item.trim())
  return values.some((item) => item.toLowerCase() === value.toLowerCase()) ? current : `${current}, ${value}`
}

/**
 * Adds `Vary: effect-views-request` to HTML responses without disturbing
 * existing Vary values, since layout responds differently to the runtime, so
 * caches keep pages and fragments apart.
 */
export const varyLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) => {
      const contentType = response.headers["content-type"]
      if (contentType === undefined || !contentType.toLowerCase().startsWith("text/html")) return response
      return HttpServerResponse.setHeader(response, "vary", appendVary(response.headers["vary"], Protocol.requestHeader))
    }),
  { global: true }
)

/** Sends the browser to another page, loading it whole, instead of putting the response into this one. */
export const redirect = (response: HttpServerResponse.HttpServerResponse, location: string) =>
  HttpServerResponse.setHeader(response, Protocol.locationHeader, location)

/**
 * Sends the browser to another page after a successful POST. An ordinary
 * request gets a 303 redirect; the runtime gets a 204 that tells it to load
 * the page, rather than putting it into the element that made the request.
 */
export const seeOther = (request: HttpServerRequest.HttpServerRequest, location: string) =>
  wantsFragment(request)
    ? HttpServerResponse.empty({ status: 204, headers: { [Protocol.locationHeader]: location } })
    : Html.seeOther(location)

/** Puts the response into the element the selector finds, instead of the one the request named. */
export const retarget = (response: HttpServerResponse.HttpServerResponse, selector: string) =>
  HttpServerResponse.setHeader(response, Protocol.targetHeader, selector)

/** Puts the response into the page another way, or not at all with "none". */
export const swap = (response: HttpServerResponse.HttpServerResponse, strategy: Protocol.Swap | "none") =>
  HttpServerResponse.setHeader(response, Protocol.swapHeader, strategy)

/**
 * Dispatches an event once the runtime has handled the response, unless it
 * loads another page: it bubbles from the element that made the request, with
 * the detail as the event's `detail`. Calling it again adds another event.
 */
export const trigger = (response: HttpServerResponse.HttpServerResponse, event: string, detail?: unknown) => {
  const current = response.headers[Protocol.eventHeader]
  const events = current === undefined ? {} : JSON.parse(current) as Record<string, unknown>
  // A header holds only ASCII, so other characters are escaped, as JSON.parse reads them
  const json = JSON.stringify({ ...events, [event]: detail ?? null })
    .replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return HttpServerResponse.setHeader(response, Protocol.eventHeader, json)
}
