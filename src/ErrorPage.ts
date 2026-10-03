import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"

import * as Html from "./Html.js"
import * as Htmx from "./Htmx.js"

export interface Info {
  readonly status: number
  readonly request: HttpServerRequest.HttpServerRequest
  /** Whether htmx sent the request, so a fragment is expected rather than a document. */
  readonly htmx: boolean
  /** Why the request failed, when it failed rather than responding with an error status. */
  readonly cause: Cause.Cause<unknown> | undefined
}

const acceptsHtml = (request: HttpServerRequest.HttpServerRequest): boolean =>
  Htmx.isRequest(request) || (request.headers["accept"] ?? "").toLowerCase().includes("text/html")

/**
 * Renders HTML for failed requests and non-HTML error responses, for browsers
 * and htmx. Requests that do not accept HTML, such as JSON API calls, are left
 * alone. Unexpected failures are logged before they are rendered.
 */
export const layer = (render: (info: Info) => Html.Html) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!acceptsHtml(request)) return yield* httpEffect
        const htmx = Htmx.isRequest(request)

        const exit = yield* Effect.exit(httpEffect)
        if (Exit.isSuccess(exit)) {
          const response = exit.value
          const contentType = response.headers["content-type"] ?? ""
          if (response.status < 400 || contentType.toLowerCase().startsWith("text/html")) return response
          return Html.response(render({ status: response.status, request, htmx, cause: undefined }), {
            status: response.status
          })
        }

        if (Cause.hasInterruptsOnly(exit.cause)) return yield* exit
        const [response] = yield* HttpServerError.causeResponse(exit.cause)
        if (response.status >= 500) yield* Effect.logError("Rendering an error page", exit.cause)
        return Html.response(render({ status: response.status, request, htmx, cause: exit.cause }), {
          status: response.status
        })
      }),
    { global: true }
  )
