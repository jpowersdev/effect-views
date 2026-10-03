import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import * as Html from "./Html.js"

export const isRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers["hx-request"]?.toLowerCase() === "true"

const appendVary = (current: string | undefined, value: string): string => {
  if (current === undefined || current.trim() === "") return value
  const values = current.split(",").map((item) => item.trim())
  return values.some((item) => item.toLowerCase() === value.toLowerCase())
    ? current
    : `${current}, ${value}`
}

/** Adds `Vary: HX-Request` to HTML responses without disturbing existing Vary values. */
export const varyLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) => {
      const contentType = response.headers["content-type"]
      if (contentType === undefined || !contentType.toLowerCase().startsWith("text/html")) return response
      return HttpServerResponse.setHeader(
        response,
        "vary",
        appendVary(response.headers["vary"], "HX-Request")
      )
    }),
  { global: true }
)

export const retarget = (response: HttpServerResponse.HttpServerResponse, selector: string) =>
  HttpServerResponse.setHeader(response, "hx-retarget", selector)

export const reswap = (response: HttpServerResponse.HttpServerResponse, strategy: string) =>
  HttpServerResponse.setHeader(response, "hx-reswap", strategy)

export const redirect = (response: HttpServerResponse.HttpServerResponse, location: string) =>
  HttpServerResponse.setHeader(response, "hx-redirect", location)

/**
 * Sends the browser to another page after a successful POST: a 303 redirect,
 * or for htmx, `HX-Location`, which loads the page with htmx and pushes its URL.
 */
export const seeOther = (request: HttpServerRequest.HttpServerRequest, location: string) =>
  isRequest(request)
    ? HttpServerResponse.empty({ status: 204, headers: { "hx-location": location } })
    : Html.seeOther(location)

export const trigger = (
  response: HttpServerResponse.HttpServerResponse,
  event: string,
  detail?: unknown
) => HttpServerResponse.setHeader(
  response,
  "hx-trigger",
  detail === undefined ? event : JSON.stringify({ [event]: detail })
)

/**
 * htmx 2 response handling that also swaps 422 responses, so a rejected form can
 * be shown again with its errors. Other 4xx and 5xx responses are still errors.
 */
export const responseHandling = [
  { code: "204", swap: false },
  { code: "[23]..", swap: true },
  { code: "422", swap: true },
  { code: "[45]..", swap: false, error: true },
  { code: "...", swap: false }
] as const

export interface ConfigProps {
  /**
   * A selector whose contents error responses replace, such as the fragments
   * rendered by ErrorPage.layer. Without it, htmx does not swap them.
   */
  readonly errorTarget?: string
  /** Other htmx configuration, merged over the response handling. */
  readonly config?: Readonly<Record<string, unknown>>
}

/** A meta element configuring htmx to swap 422 responses, and errors when errorTarget is set. */
export const Config = (props: ConfigProps): Html.Html => {
  const handling = props.errorTarget === undefined
    ? responseHandling
    : responseHandling.map((entry) =>
      entry.code === "[45].."
        ? { code: entry.code, swap: true, error: true, target: props.errorTarget, swapOverride: "innerHTML" }
        : entry
    )
  return Html.element("meta", {
    name: "htmx-config",
    content: JSON.stringify({ responseHandling: handling, ...props.config })
  })
}
