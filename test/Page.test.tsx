/** @jsxImportSource effect-views */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as Page from "../src/Page.js"

// A page with a header, which a fragment-only response would lose
const Document = ({ children }: { readonly children: Html.Child }): Html.Html => (
  <body><header>Site</header>{children}</body>
)
const page = Page.layout(Document)

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return Html.response(page(request, <p>Hi</p>))
    })),
    HttpRouter.add("POST", "/done", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return Page.seeOther(request, "/next")
    })),
    HttpRouter.add("GET", "/missing", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return page(request, <p>Gone</p>, { status: 404 })
    })),
    HttpRouter.add("GET", "/varied", Effect.succeed(Html.response(<p>Hi</p>, { headers: { vary: "Accept-Language" } }))),
    Page.varyLayer
  ),
  { disableLogger: true }
)

Vitest.afterAll(() => app.dispose())

const get = async (path: string, headers: Record<string, string> = {}) => {
  const response = await app.handler(new Request(`http://localhost${path}`, { headers }))
  return { status: response.status, vary: response.headers.get("vary"), body: await response.text() }
}

const runtime = { "effect-views-request": "true" }

Vitest.describe("Page.layout", () => {
  Vitest.it("sends the view alone to the runtime and inside the page otherwise", async () => {
    Vitest.expect(await get("/", runtime)).toEqual({ status: 200, vary: "effect-views-request", body: "<p>Hi</p>" })
    Vitest.expect((await get("/")).body).toBe("<body><header>Site</header><p>Hi</p></body>")
  })

  Vitest.it("sets a status when given options", async () => {
    Vitest.expect(await get("/missing")).toEqual({
      status: 404, vary: "effect-views-request", body: "<body><header>Site</header><p>Gone</p></body>"
    })
    Vitest.expect((await get("/missing", runtime)).body).toBe("<p>Gone</p>")
  })
})

Vitest.describe("Page.varyLayer", () => {
  Vitest.it("adds to the response's own Vary", async () => {
    Vitest.expect((await get("/varied")).vary).toBe("Accept-Language, effect-views-request")
  })
})

Vitest.describe("Page.wantsFragment", () => {
  const request = (headers: Record<string, string>) =>
    HttpServerRequest.fromWeb(new Request("http://localhost/", { headers }))

  Vitest.it("is true only for the runtime's requests", () => {
    Vitest.expect(Page.wantsFragment(request(runtime))).toBe(true)
    Vitest.expect(Page.wantsFragment(request({ "effect-views-request": "TRUE" }))).toBe(true)
    Vitest.expect(Page.wantsFragment(request({ "effect-views-request": "false" }))).toBe(false)
    Vitest.expect(Page.wantsFragment(request({}))).toBe(false)
  })
})

Vitest.describe("Page.seeOther", () => {
  const post = (headers: Record<string, string>) =>
    app.handler(new Request("http://localhost/done", { method: "POST", headers }))

  Vitest.it("redirects ordinary requests with a 303", async () => {
    const response = await post({})
    Vitest.expect(response.status).toBe(303)
    Vitest.expect(response.headers.get("location")).toBe("/next")
  })

  Vitest.it("tells the runtime to load the page, rather than following a redirect to a fragment", async () => {
    const response = await post(runtime)
    Vitest.expect(response.status).toBe(204)
    Vitest.expect(response.headers.get("location")).toBeNull()
    Vitest.expect(response.headers.get("effect-views-location")).toBe("/next")
  })
})

Vitest.describe("response headers", () => {
  const response = HttpServerResponse.empty()

  Vitest.it("tell the runtime where the response goes, and how", () => {
    Vitest.expect(Page.retarget(response, "#errors").headers["effect-views-target"]).toBe("#errors")
    Vitest.expect(Page.swap(response, "append").headers["effect-views-swap"]).toBe("append")
    Vitest.expect(Page.swap(response, "none").headers["effect-views-swap"]).toBe("none")
    Vitest.expect(Page.redirect(response, "/orders").headers["effect-views-location"]).toBe("/orders")
  })

  Vitest.it("collect events to dispatch, with their details", () => {
    const triggered = Page.trigger(Page.trigger(response, "saved", { id: 7 }), "closed")
    Vitest.expect(JSON.parse(triggered.headers["effect-views-event"]!)).toEqual({ saved: { id: 7 }, closed: null })
  })

  Vitest.it("escape what a header cannot hold, which the runtime's JSON.parse restores", () => {
    const header = Page.trigger(response, "saved", { title: "Café ☕ 🎉" }).headers["effect-views-event"]!
    Vitest.expect(/^[\x20-\x7e]*$/.test(header)).toBe(true)
    Vitest.expect(JSON.parse(header)).toEqual({ saved: { title: "Café ☕ 🎉" } })
    // Node's own check for a header value
    Vitest.expect(() => new Headers({ "effect-views-event": header })).not.toThrow()
  })
})
