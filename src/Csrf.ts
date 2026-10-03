import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

export interface Options {
  /** Origins, such as "https://admin.example.com", allowed to submit cross-origin. */
  readonly trustedOrigins?: ReadonlyArray<string>
  /** The response to a rejected request. Defaults to a plain-text 403. */
  readonly reject?: (request: HttpServerRequest.HttpServerRequest) => HttpServerResponse.HttpServerResponse
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

/**
 * Whether a request that changes state came from another origin.
 *
 * Browsers send `Sec-Fetch-Site` with every request; when it is missing, the
 * `Origin` header is compared with `Host`. Requests with neither header are not
 * from a browser that could be tricked into sending them, and are allowed.
 */
export const isCrossOrigin = (request: HttpServerRequest.HttpServerRequest, options?: Options): boolean => {
  if (safeMethods.has(request.method)) return false

  const origin = request.headers["origin"]
  if (origin !== undefined && options?.trustedOrigins?.includes(origin)) return false

  const site = request.headers["sec-fetch-site"]
  if (site !== undefined) return site !== "same-origin" && site !== "none"

  if (origin === undefined) return false
  const originHost = hostOf(origin)
  const host = request.headers["host"] ?? hostOf(request.originalUrl)
  return originHost === undefined || originHost !== host
}

const forbidden = () => HttpServerResponse.text("Cross-origin request blocked", { status: 403 })

/**
 * Rejects cross-origin POST, PUT, PATCH, and DELETE requests with Fetch
 * Metadata, without tokens or session state. Use with SameSite cookies.
 */
export const layer = (options?: Options) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (isCrossOrigin(request, options)) return (options?.reject ?? forbidden)(request)
        return yield* httpEffect
      }),
    { global: true }
  )
