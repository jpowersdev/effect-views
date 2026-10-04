/** @jsxImportSource effect-views */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as Htmx from "../src/Htmx.js"

// A page with a header, which a fragment-only response would lose
const Page = ({ children }: { readonly children: Html.Child }): Html.Html => (
  <body><header>Site</header>{children}</body>
)
const page = Htmx.layout(Page)

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return Html.response(page(request, <p>Hi</p>))
    })),
    HttpRouter.add("POST", "/done", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return Htmx.seeOther(request, "/next")
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

const htmx = { "HX-Request": "true" }
const boosted = { "HX-Request": "true", "HX-Boosted": "true" }

Vitest.describe("Htmx.layout", () => {
  Vitest.it("sends the view alone to htmx and inside the page otherwise", async () => {
    Vitest.expect(await get("/", { "HX-Request": "true" })).toEqual({
      status: 200, vary: "HX-Request, HX-Boosted", body: "<p>Hi</p>"
    })
    Vitest.expect((await get("/")).body).toBe("<body><header>Site</header><p>Hi</p></body>")
  })

  Vitest.it("sends the page to boosted requests, which swap the whole body", async () => {
    Vitest.expect((await get("/", boosted)).body).toBe("<body><header>Site</header><p>Hi</p></body>")
  })

  Vitest.it("sets a status when given options", async () => {
    Vitest.expect(await get("/missing")).toEqual({
      status: 404, vary: "HX-Request, HX-Boosted", body: "<body><header>Site</header><p>Gone</p></body>"
    })
    Vitest.expect((await get("/missing", { "HX-Request": "true" })).body).toBe("<p>Gone</p>")
  })
})

Vitest.describe("Htmx.wantsFragment", () => {
  const request = (headers: Record<string, string>) =>
    HttpServerRequest.fromWeb(new Request("http://localhost/", { headers }))

  Vitest.it("is true only for htmx requests that are not boosted", () => {
    Vitest.expect(Htmx.wantsFragment(request(htmx))).toBe(true)
    Vitest.expect(Htmx.wantsFragment(request(boosted))).toBe(false)
    Vitest.expect(Htmx.wantsFragment(request({}))).toBe(false)
  })
})

Vitest.describe("Htmx.seeOther", () => {
  Vitest.afterAll(() => app.dispose())

  const post = (headers: Record<string, string>) =>
    app.handler(new Request("http://localhost/done", { method: "POST", headers }))

  Vitest.it("redirects ordinary and boosted requests with a 303, which htmx follows", async () => {
    for (const headers of [{}, boosted]) {
      const response = await post(headers)
      Vitest.expect(response.status).toBe(303)
      Vitest.expect(response.headers.get("location")).toBe("/next")
    }
  })

  Vitest.it("tells other htmx requests to load the whole page", async () => {
    const response = await post(htmx)
    Vitest.expect(response.status).toBe(204)
    Vitest.expect(response.headers.get("hx-redirect")).toBe("/next")
  })
})
