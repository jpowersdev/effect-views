import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { randomBytes } from "node:crypto"

/** A content security policy's directives, by name, each with its sources. */
export type Directives = Readonly<Record<string, ReadonlyArray<string>>>

/** The nonce for the response being rendered; see layer. */
export const Nonce = Context.Reference<string | undefined>("effect-views/Csp/Nonce", {
  defaultValue: () => undefined
})

/**
 * A strict policy: everything from the page's own origin, inline scripts and
 * styles only with the response's nonce, and no plugins, base URL changes,
 * framing by other sites, or form posts elsewhere.
 */
export const strict = (nonce: string): Directives => ({
  "default-src": ["'self'"],
  "script-src": ["'self'", nonce],
  "style-src": ["'self'", nonce],
  "img-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"]
})

export interface Options {
  /**
   * The policy, given the response's nonce as a source, such as
   * `'nonce-k3J…'`. Defaults to strict.
   */
  readonly directives?: (nonce: string) => Directives
}

/** Renders directives as a header value. */
export const render = (directives: Directives): string =>
  Object.entries(directives).map(([name, sources]) => [name, ...sources].join(" ")).join("; ")

/**
 * Gives each response a fresh nonce and sends the policy with it, unless the
 * response sets its own. While a request is handled, `nonce()` returns it, so
 * pages can mark the inline scripts and styles they trust, and `Assets.Head`
 * marks the effect-views runtime's scripts with it.
 *
 * ```ts
 * const app = Layer.mergeAll(routes, Csp.layer({
 *   directives: (nonce) => ({ ...Csp.strict(nonce), "frame-src": ["https://www.youtube.com"] })
 * }))
 * ```
 */
export const layer = (options?: Options) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const nonce = randomBytes(16).toString("base64")
        const response = yield* Effect.provideService(httpEffect, Nonce, nonce)
        if (response.headers["content-security-policy"] !== undefined) return response
        const directives = (options?.directives ?? strict)(`'nonce-${nonce}'`)
        return HttpServerResponse.setHeader(response, "content-security-policy", render(directives))
      }),
    { global: true }
  )

/** The nonce for the response being rendered, if `layer` is in use. */
export const nonce = (): string | undefined => {
  const fiber = Fiber.getCurrent()
  return fiber === undefined ? undefined : Context.get(fiber.context, Nonce)
}
