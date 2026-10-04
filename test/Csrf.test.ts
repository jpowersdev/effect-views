import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Vitest from "vitest"

import * as Csrf from "../src/Csrf.js"

const makeApp = (options?: Csrf.Options) => HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/", Effect.succeed(HttpServerResponse.text("page"))),
    HttpRouter.add("POST", "/todos", Effect.succeed(HttpServerResponse.text("created"))),
    Csrf.layer(options)
  ),
  { disableLogger: true }
)

const post = (headers: Record<string, string>) =>
  new Request("http://app.test/todos", { method: "POST", headers })

Vitest.describe("Csrf", () => {
  Vitest.it("allows same-origin and non-browser requests", async () => {
    const { dispose, handler } = makeApp()
    try {
      for (const headers of [
        { "sec-fetch-site": "same-origin" },
        { "sec-fetch-site": "none" },
        { origin: "http://app.test" },
        {}
      ]) {
        const response = await handler(post(headers))
        Vitest.expect(response.status, JSON.stringify(headers)).toBe(200)
      }
    } finally {
      await dispose()
    }
  })

  Vitest.it("rejects cross-origin requests that change state", async () => {
    const { dispose, handler } = makeApp()
    try {
      for (const headers of [
        { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
        { "sec-fetch-site": "same-site", origin: "http://other.app.test" },
        { origin: "https://evil.test" },
        { origin: "null" }
      ]) {
        const response = await handler(post(headers))
        Vitest.expect(response.status, JSON.stringify(headers)).toBe(403)
      }

      const read = await handler(new Request("http://app.test/", {
        headers: { "sec-fetch-site": "cross-site" }
      }))
      Vitest.expect(read.status).toBe(200)
    } finally {
      await dispose()
    }
  })

  Vitest.it("allows trusted origins and custom rejections", async () => {
    const { dispose, handler } = makeApp({
      trustedOrigins: ["https://admin.app.test"],
      reject: () => HttpServerResponse.text("nope", { status: 400 })
    })
    try {
      const trusted = await handler(post({ "sec-fetch-site": "same-site", origin: "https://admin.app.test" }))
      Vitest.expect(trusted.status).toBe(200)

      const rejected = await handler(post({ "sec-fetch-site": "cross-site", origin: "https://evil.test" }))
      Vitest.expect(rejected.status).toBe(400)
      Vitest.expect(await rejected.text()).toBe("nope")
    } finally {
      await dispose()
    }
  })
})
