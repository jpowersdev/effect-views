import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Layer from "effect/Layer"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Vitest from "vitest"

import * as Http from "../examples/todo-list/Http.js"

const makeApp = () => HttpRouter.toWebHandler(
  Http.routes.pipe(
    Layer.provide(Layer.mergeAll(
      NodeServices.layer,
      NodeHttpPlatform.layer,
      Etag.layer
    ))
  ),
  { disableLogger: true }
)

Vitest.describe("todo list example", () => {
  Vitest.it("serves pages and fragments and shares form submissions with the JSON API", async () => {
    const { dispose, handler } = makeApp()

    try {
      const page = await handler(new Request("http://localhost/"))
      Vitest.expect(page.status).toBe(200)
      Vitest.expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
      Vitest.expect(page.headers.get("vary")).toBe("HX-Request")
      const pageBody = await page.text()
      Vitest.expect(pageBody).toMatch(/^<!doctype html>/)
      // Keep the browser on /; the form's /todos action has no GET route.
      Vitest.expect(pageBody).toMatch(/<form\b[^>]*\bhx-push-url="false"/)

      const fragment = await handler(new Request("http://localhost/", {
        headers: { "HX-Request": "true" }
      }))
      Vitest.expect(fragment.status).toBe(200)
      Vitest.expect(fragment.headers.get("vary")).toBe("HX-Request")
      const fragmentBody = await fragment.text()
      Vitest.expect(fragmentBody).toMatch(/^<main id="todo-app">/)
      Vitest.expect(fragmentBody).not.toContain("<!doctype html>")
      Vitest.expect(fragmentBody).toMatch(/<form\b[^>]*\bhx-push-url="false"/)

      const title = "<script>alert(1)</script>"
      const created = await handler(new Request("http://localhost/todos", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ title })
      }))
      Vitest.expect(created.status).toBe(200)
      Vitest.expect(created.headers.get("vary")).toBe("HX-Request")
      const createdBody = await created.text()
      Vitest.expect(createdBody).toMatch(/^<main id="todo-app">/)
      Vitest.expect(createdBody).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
      Vitest.expect(createdBody).not.toContain(title)
      Vitest.expect(createdBody).toMatch(/<form\b[^>]*\bhx-push-url="false"/)

      const nativeSubmission = await handler(new Request("http://localhost/todos", {
        method: "POST",
        body: new URLSearchParams({ title: "Without JavaScript" })
      }))
      Vitest.expect(nativeSubmission.status).toBe(200)
      const nativeBody = await nativeSubmission.text()
      Vitest.expect(nativeBody).toMatch(/^<!doctype html>/)
      Vitest.expect(nativeBody).toContain("Without JavaScript")

      const json = await handler(new Request("http://localhost/api/todos"))
      Vitest.expect(json.status).toBe(200)
      Vitest.expect(json.headers.get("content-type")).toContain("application/json")
      Vitest.expect(json.headers.get("vary")).toBeNull()
      Vitest.expect(await json.json()).toEqual([
        { id: 1, title: "Try Effect views" },
        { id: 2, title: "Build a hypermedia application" },
        { id: 3, title },
        { id: 4, title: "Without JavaScript" }
      ])
    } finally {
      await dispose()
    }
  })

  Vitest.it("rejects invalid form submissions without changing the todo list", async () => {
    const { dispose, handler } = makeApp()

    try {
      const before = await handler(new Request("http://localhost/api/todos"))
      const initial = await before.json()
      const invalid = await handler(new Request("http://localhost/todos", {
        method: "POST",
        body: new URLSearchParams({ title: "" })
      }))
      Vitest.expect(invalid.status).toBe(400)

      const after = await handler(new Request("http://localhost/api/todos"))
      Vitest.expect(await after.json()).toEqual(initial)
    } finally {
      await dispose()
    }
  })
})
