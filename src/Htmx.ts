import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

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

export const trigger = (
  response: HttpServerResponse.HttpServerResponse,
  event: string,
  detail?: unknown
) => HttpServerResponse.setHeader(
  response,
  "hx-trigger",
  detail === undefined ? event : JSON.stringify({ [event]: detail })
)
