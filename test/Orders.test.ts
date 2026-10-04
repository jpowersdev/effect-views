import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as Vitest from "vitest"

import * as App from "../examples/orders/App.js"
import * as Assets from "../src/Assets.js"
import * as Csrf from "../src/Csrf.js"
import * as Htmx from "../src/Htmx.js"

Vitest.describe("orders example", () => {
  Vitest.it("serves documents and htmx fragments from the same view endpoints", async () => {
    const app = Layer.mergeAll(
      App.routes.pipe(
        Layer.provide(Layer.mergeAll(
          NodeServices.layer,
          NodeHttpPlatform.layer,
          Etag.layer,
          Assets.layer()
        ))
      ),
      App.errorPages,
      Htmx.varyLayer,
      Csrf.layer()
    )
    const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })

    try {
      const index = await handler(new Request("http://localhost/"))
      const indexBody = await index.text()
      Vitest.expect(index.status).toBe(200)
      Vitest.expect(indexBody).toContain("<!doctype html>")
      Vitest.expect(indexBody).toContain('href="/orders/42"')
      Vitest.expect(indexBody).toContain("Active")

      const page = await handler(new Request("http://localhost/orders/42"))
      Vitest.expect(page.status).toBe(200)
      Vitest.expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
      Vitest.expect(page.headers.get("vary")).toBe("HX-Request, HX-Boosted")
      Vitest.expect(await page.text()).toContain("<!doctype html>")

      const fragment = await handler(new Request("http://localhost/orders/42", {
        headers: { "HX-Request": "true" }
      }))
      const fragmentBody = await fragment.text()
      Vitest.expect(fragmentBody).toMatch(/^<article/)
      Vitest.expect(fragmentBody).not.toContain("<!doctype html>")
      Vitest.expect(fragmentBody).toContain('hx-get="/orders/42/activity"')

      const activity = await handler(new Request("http://localhost/orders/42/activity", {
        headers: { "HX-Request": "true" }
      }))
      const activityBody = await activity.text()
      Vitest.expect(activityBody).toMatch(/^<section>/)
      Vitest.expect(activityBody).toContain("<li>Order placed</li>")

      const cancelled = await handler(new Request("http://localhost/orders/42/cancel", {
        method: "POST",
        headers: { "HX-Request": "true" }
      }))
      const cancelledBody = await cancelled.text()
      Vitest.expect(cancelledBody).toContain("Cancelled")
      Vitest.expect(cancelledBody).not.toContain("Cancel order")

      const updatedActivity = await handler(new Request("http://localhost/orders/42/activity"))
      const updatedActivityBody = await updatedActivity.text()
      Vitest.expect(updatedActivityBody).toContain("<!doctype html>")
      Vitest.expect(updatedActivityBody).toContain("<li>Order cancelled</li>")

      const updatedIndex = await handler(new Request("http://localhost/"))
      Vitest.expect(await updatedIndex.text()).toContain("Cancelled")

      // Expected errors: the handler renders a 404 for a missing order.
      const missing = await handler(new Request("http://localhost/orders/7"))
      Vitest.expect(missing.status).toBe(404)
      Vitest.expect(await missing.text()).toContain("Order #7 not found")

      // Unknown routes and invalid params become pages for browsers...
      const browser = { Accept: "text/html,application/xhtml+xml" }
      const unknown = await handler(new Request("http://localhost/nope", { headers: browser }))
      Vitest.expect(unknown.status).toBe(404)
      Vitest.expect(unknown.headers.get("content-type")).toBe("text/html; charset=utf-8")
      const unknownBody = await unknown.text()
      Vitest.expect(unknownBody).toMatch(/^<!doctype html>/)
      Vitest.expect(unknownBody).toContain("There is nothing here.")

      const invalid = await handler(new Request("http://localhost/orders/abc", { headers: browser }))
      Vitest.expect(invalid.status).toBe(400)
      Vitest.expect(await invalid.text()).toContain("That request was not understood.")

      const forged = await handler(new Request("http://localhost/orders/42/cancel", {
        method: "POST",
        headers: { ...browser, "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" }
      }))
      Vitest.expect(forged.status).toBe(403)
      Vitest.expect(await forged.text()).toContain("That request was blocked.")

      // ...fragments for htmx...
      const unknownFragment = await handler(new Request("http://localhost/nope", {
        headers: { "HX-Request": "true" }
      }))
      Vitest.expect(unknownFragment.status).toBe(404)
      Vitest.expect(await unknownFragment.text()).toBe("<p>There is nothing here.</p>")

      // ...and are left alone for clients that do not accept HTML.
      const api = await handler(new Request("http://localhost/nope"))
      Vitest.expect(api.status).toBe(404)
      Vitest.expect(api.headers.get("content-type")).not.toBe("text/html; charset=utf-8")
    } finally {
      await dispose()
    }
  })
})
