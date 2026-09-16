import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as HttpFormEndpoint from "../src/HttpFormEndpoint.js"

Vitest.describe("HttpFormEndpoint", () => {
  Vitest.it("creates a POST URL-encoded endpoint with an Html response", () => {
    const payload = Schema.Struct({ title: Schema.NonEmptyString })
    const endpoint = HttpFormEndpoint.make("create", "/todos", { payload })

    Vitest.expect(endpoint.method).toBe("POST")
    Vitest.expect(endpoint.path).toBe("/todos")
    Vitest.expect(endpoint.payload.get("application/x-www-form-urlencoded")?.encoding._tag)
      .toBe("FormUrlEncoded")
    Vitest.expect(endpoint.success.has(Html.schema)).toBe(true)
    Vitest.expect(HttpFormEndpoint.isHttpFormEndpoint(endpoint)).toBe(true)
    Vitest.expect(HttpFormEndpoint.getPayload(endpoint)).toBe(payload)
  })
})
