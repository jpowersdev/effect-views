/** @jsxImportSource effect-views */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as Htmx from "../src/Htmx.js"

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => <body>{children}</body>
const page = Htmx.layout(Page)

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return Html.response(page(request, <p>Hi</p>))
    })),
    HttpRouter.add("GET", "/missing", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return page(request, <p>Gone</p>, { status: 404 })
    })),
    Htmx.varyLayer
  ),
  { disableLogger: true }
)

const get = async (path: string, headers: Record<string, string> = {}) => {
  const response = await app.handler(new Request(`http://localhost${path}`, { headers }))
  return { status: response.status, vary: response.headers.get("vary"), body: await response.text() }
}

Vitest.describe("Htmx.layout", () => {
  Vitest.afterAll(() => app.dispose())

  Vitest.it("sends the view alone to htmx and inside the page otherwise", async () => {
    Vitest.expect(await get("/", { "HX-Request": "true" })).toEqual({
      status: 200, vary: "HX-Request, HX-Boosted", body: "<p>Hi</p>"
    })
    Vitest.expect((await get("/")).body).toBe("<body><p>Hi</p></body>")
  })

  Vitest.it("sends the page to boosted requests, which swap the whole body", async () => {
    Vitest.expect((await get("/", { "HX-Request": "true", "HX-Boosted": "true" })).body).toBe("<body><p>Hi</p></body>")
  })

  Vitest.it("sets a status when given options", async () => {
    Vitest.expect(await get("/missing")).toEqual({
      status: 404, vary: "HX-Request, HX-Boosted", body: "<body><p>Gone</p></body>"
    })
    Vitest.expect((await get("/missing", { "HX-Request": "true" })).body).toBe("<p>Gone</p>")
  })
})
