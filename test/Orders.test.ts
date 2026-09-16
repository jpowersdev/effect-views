import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as Vitest from "vitest"

import * as App from "../examples/orders/App.js"
import * as Htmx from "../src/Htmx.js"

Vitest.describe("orders example", () => {
  Vitest.it("serves documents and htmx fragments from the same view endpoints", async () => {
    const app = Layer.mergeAll(
      App.routes.pipe(
        Layer.provide(Layer.mergeAll(
          NodeServices.layer,
          NodeHttpPlatform.layer,
          Etag.layer
        ))
      ),
      Htmx.varyLayer
    )
    const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })

    try {
      const page = await handler(new Request("http://localhost/orders/42"))
      Vitest.expect(page.status).toBe(200)
      Vitest.expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
      Vitest.expect(page.headers.get("vary")).toBe("HX-Request")
      Vitest.expect(await page.text()).toContain("<!doctype html>")

      const fragment = await handler(new Request("http://localhost/orders/42", {
        headers: { "HX-Request": "true" }
      }))
      const fragmentBody = await fragment.text()
      Vitest.expect(fragmentBody).toMatch(/^<article/)
      Vitest.expect(fragmentBody).not.toContain("<!doctype html>")

      const cancelled = await handler(new Request("http://localhost/orders/42/cancel", {
        method: "POST",
        headers: { "HX-Request": "true" }
      }))
      const cancelledBody = await cancelled.text()
      Vitest.expect(cancelledBody).toContain("Cancelled")
      Vitest.expect(cancelledBody).not.toContain("Cancel order")
    } finally {
      await dispose()
    }
  })
})
