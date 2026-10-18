/** @jsxImportSource effect-views */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Vitest from "vitest"

import * as Assets from "../src/Assets.js"
import * as Csp from "../src/Csp.js"
import * as Html from "../src/Html.js"
import * as Htmx from "../src/Htmx.js"

// A page with an inline script it trusts, htmx's configuration, and the assets
const page = Effect.sync(() =>
  Html.response(
    <html>
      <head>
        <Htmx.Config />
        <Assets.Head />
      </head>
      <body>
        <script nonce={Csp.nonce()}>{Html.unsafe("document.body.dataset.ready = 'yes'")}</script>
      </body>
    </html>
  )
)

const makeApp = (options?: Csp.Options) =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", "/", page),
      HttpRouter.add("GET", "/own", Effect.succeed(HttpServerResponse.text("Hi", {
        headers: { "content-security-policy": "default-src 'none'" }
      }))),
      Assets.routes,
      Csp.layer(options)
    ).pipe(Layer.provide(Assets.layer({ htmx: { url: "/vendor/htmx.js" } }))),
    { disableLogger: true }
  )

const get = async (app: ReturnType<typeof makeApp>, path: string) => {
  const response = await app.handler(new Request(`http://localhost${path}`))
  return { policy: response.headers.get("content-security-policy") ?? "", body: await response.text() }
}

const nonceIn = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1]

Vitest.describe("Csp", () => {
  Vitest.it("sends a strict policy with a fresh nonce, which the page can use", async () => {
    const app = makeApp()
    try {
      const first = await get(app, "/")
      const nonce = nonceIn(first.policy)
      Vitest.expect(nonce).toBeDefined()
      Vitest.expect(first.policy).toBe(
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; ` +
          `img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
      )
      Vitest.expect(first.body).toContain(`<script nonce="${nonce}">`)
      // htmx marks the styles and scripts it adds, and Assets.Head its own scripts
      Vitest.expect(first.body).toContain(`&quot;inlineStyleNonce&quot;:&quot;${nonce}&quot;`)
      Vitest.expect(first.body).toContain(`<script src="/vendor/htmx.js" defer nonce="${nonce}"></script>`)

      const second = await get(app, "/")
      Vitest.expect(nonceIn(second.policy)).not.toBe(nonce)
    } finally {
      await app.dispose()
    }
  })

  Vitest.it("takes the application's own directives, and leaves a response's own policy alone", async () => {
    const app = makeApp({
      directives: (nonce) => ({ ...Csp.strict(nonce), "frame-src": ["https://www.youtube.com"] })
    })
    try {
      Vitest.expect((await get(app, "/")).policy).toMatch(/; frame-src https:\/\/www\.youtube\.com$/)
      Vitest.expect((await get(app, "/own")).policy).toBe("default-src 'none'")
    } finally {
      await app.dispose()
    }
  })

  Vitest.it("has no nonce outside a request", () => {
    Vitest.expect(Csp.nonce()).toBeUndefined()
    Vitest.expect(Html.render(<Htmx.Config />)).not.toContain("Nonce")
  })
})
