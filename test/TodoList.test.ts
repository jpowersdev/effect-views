import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Layer from "effect/Layer"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Vitest from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Http from "../examples/todo-list/Http.js"

const makeApp = (filename = ":memory:") => HttpRouter.toWebHandler(
  Http.routes.pipe(
    Layer.provide(Layer.mergeAll(
      NodeServices.layer,
      NodeHttpPlatform.layer,
      Etag.layer,
      SqliteClient.layer({ filename })
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
      // Post/Redirect/Get: reloading the result does not submit again.
      Vitest.expect(nativeSubmission.status).toBe(303)
      Vitest.expect(nativeSubmission.headers.get("location")).toBe("/")
      const afterRedirect = await handler(new Request("http://localhost/"))
      Vitest.expect(await afterRedirect.text()).toContain("Without JavaScript")

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

  Vitest.it("shows invalid submissions again with their errors, without changing the todo list", async () => {
    const { dispose, handler } = makeApp()

    try {
      const before = await handler(new Request("http://localhost/api/todos"))
      const initial = await before.json()

      const invalid = await handler(new Request("http://localhost/todos", {
        method: "POST",
        body: new URLSearchParams({ title: "" })
      }))
      Vitest.expect(invalid.status).toBe(422)
      Vitest.expect(invalid.headers.get("content-type")).toBe("text/html; charset=utf-8")
      const invalidBody = await invalid.text()
      Vitest.expect(invalidBody).toMatch(/^<!doctype html>/)
      Vitest.expect(invalidBody).toContain('aria-invalid="true" aria-describedby="new-todo-title-error"')
      Vitest.expect(invalidBody).toContain('<p class="error" id="new-todo-title-error">Expected a value with a length of at least 1</p>')

      const duplicate = await handler(new Request("http://localhost/todos", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ title: "Try Effect views" })
      }))
      Vitest.expect(duplicate.status).toBe(422)
      const duplicateBody = await duplicate.text()
      Vitest.expect(duplicateBody).toMatch(/^<main id="todo-app">/)
      Vitest.expect(duplicateBody).toContain('value="Try Effect views"')
      Vitest.expect(duplicateBody).toContain("That is already on the list")

      const crossSite = await handler(new Request("http://localhost/todos", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" },
        body: new URLSearchParams({ title: "Forged" })
      }))
      Vitest.expect(crossSite.status).toBe(403)

      const duplicateJson = await handler(new Request("http://localhost/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Try Effect views" })
      }))
      Vitest.expect(duplicateJson.status).toBe(409)
      Vitest.expect(await duplicateJson.json()).toEqual({ _tag: "DuplicateTodo", title: "Try Effect views" })

      const after = await handler(new Request("http://localhost/api/todos"))
      Vitest.expect(await after.json()).toEqual(initial)
    } finally {
      await dispose()
    }
  })

  Vitest.it("keeps todos in the database across restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "effect-views-"))
    const filename = join(directory, "todos.sqlite")

    try {
      const first = makeApp(filename)
      await first.handler(new Request("http://localhost/todos", {
        method: "POST",
        body: new URLSearchParams({ title: "Survive a restart" })
      }))
      await first.dispose()

      const second = makeApp(filename)
      try {
        const json = await second.handler(new Request("http://localhost/api/todos"))
        Vitest.expect(await json.json()).toEqual([
          { id: 1, title: "Try Effect views" },
          { id: 2, title: "Build a hypermedia application" },
          { id: 3, title: "Survive a restart" }
        ])
      } finally {
        await second.dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
