/** @jsxImportSource effect-views */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Vitest from "vitest"

import * as ErrorPage from "../src/ErrorPage.js"
import * as Html from "../src/Html.js"

const makeApp = () => HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/boom", Effect.die(new Error("kaboom"))),
    HttpRouter.add("GET", "/teapot", Effect.succeed(HttpServerResponse.text("short and stout", { status: 418 }))),
    HttpRouter.add("GET", "/rejected", Effect.succeed(Html.response(<p>Fix the form</p>, { status: 422 }))),
    ErrorPage.layer(({ cause, fragment, status }) => (
      <p data-fragment={fragment} data-cause={cause !== undefined}>Error {status}</p>
    ))
  ),
  { disableLogger: true }
)

const html = { Accept: "text/html" }

Vitest.describe("ErrorPage", () => {
  Vitest.it("renders failures as HTML with their status and logs them", async () => {
    const { dispose, handler } = makeApp()
    const log = Vitest.vi.spyOn(console, "log").mockImplementation(() => {})
    const error = Vitest.vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const response = await handler(new Request("http://localhost/boom", { headers: html }))
      Vitest.expect(response.status).toBe(500)
      Vitest.expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
      Vitest.expect(await response.text()).toBe(`<p data-cause>Error 500</p>`)
      const output = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n")
      Vitest.expect(output).toContain("Rendering an error page")
      Vitest.expect(output).toContain("kaboom")

      const fragment = await handler(new Request("http://localhost/boom", { headers: { "HX-Request": "true" } }))
      Vitest.expect(await fragment.text()).toBe(`<p data-fragment data-cause>Error 500</p>`)

      const boosted = await handler(new Request("http://localhost/boom", {
        headers: { "HX-Request": "true", "HX-Boosted": "true" }
      }))
      Vitest.expect(await boosted.text()).toBe(`<p data-cause>Error 500</p>`)
    } finally {
      log.mockRestore()
      error.mockRestore()
      await dispose()
    }
  })

  Vitest.it("replaces non-HTML error responses and keeps HTML ones", async () => {
    const { dispose, handler } = makeApp()
    try {
      const teapot = await handler(new Request("http://localhost/teapot", { headers: html }))
      Vitest.expect(teapot.status).toBe(418)
      Vitest.expect(await teapot.text()).toBe(`<p>Error 418</p>`)

      const rejected = await handler(new Request("http://localhost/rejected", { headers: html }))
      Vitest.expect(rejected.status).toBe(422)
      Vitest.expect(await rejected.text()).toBe(`<p>Fix the form</p>`)
    } finally {
      await dispose()
    }
  })

  Vitest.it("leaves requests that do not accept HTML alone", async () => {
    const { dispose, handler } = makeApp()
    try {
      const response = await handler(new Request("http://localhost/teapot", { headers: { Accept: "application/json" } }))
      Vitest.expect(response.status).toBe(418)
      Vitest.expect(await response.text()).toBe("short and stout")
    } finally {
      await dispose()
    }
  })
})
