import * as Schema from "effect/Schema"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"
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
  Vitest.it("describes the form's fields, as they are submitted, in the OpenAPI document", () => {
    const payload = Schema.Struct({
      title: Schema.Trim,
      done: Schema.optionalKey(Schema.Boolean)
    }).annotate({ identifier: "CreateTodo" })
    const endpoint = HttpFormEndpoint.make("create", "/todos", {
      payload,
      annotations: OpenApi.annotations({ summary: "Add a todo" })
    })
    const spec = OpenApi.fromApi(HttpApi.make("api").add(HttpApiGroup.make("todos").add(endpoint)))
    const operation = spec.paths["/todos"]?.post

    Vitest.expect(operation?.summary).toBe("Add a todo")
    Vitest.expect(operation?.requestBody).toEqual({
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: { title: { type: "string" }, done: { type: "string", enum: ["true", "false"] } },
            required: ["title"]
          }
        }
      }
    })
    // The values a form decodes from are not listed as a model of their own
    Vitest.expect(Object.keys(spec.components.schemas)).toEqual(["Html"])
    // Annotations given to make keep the metadata Form.derive needs
    Vitest.expect(HttpFormEndpoint.getPayload(endpoint)).toBe(payload)
  })
})
