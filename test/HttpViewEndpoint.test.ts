import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"

Vitest.describe("HttpViewEndpoint", () => {
  Vitest.it("specializes successful responses as HTML", () => {
    const endpoint = HttpViewEndpoint.get("home", "/", {
      query: { page: Schema.optionalKey(Schema.Int) }
    })
    Vitest.expect(endpoint.method).toBe("GET")
    Vitest.expect(endpoint.success.has(Html.schema)).toBe(true)
  })

  Vitest.it("marks form payloads as URL encoded", () => {
    const payload = HttpViewEndpoint.form(Schema.Struct({ name: Schema.String }))
    const endpoint = HttpViewEndpoint.post("create", "/contacts", { payload })
    const entry = endpoint.payload.get("application/x-www-form-urlencoded")

    Vitest.expect(entry?.encoding._tag).toBe("FormUrlEncoded")
  })
})
