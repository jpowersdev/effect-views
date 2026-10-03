import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as Submission from "../src/Submission.js"

const Contact = Schema.Struct({
  name: Schema.NonEmptyString,
  age: Schema.Int,
  subscribe: Schema.Boolean
})

Vitest.describe("Submission", () => {
  Vitest.it("decodes URL-encoded values as an HTTP form body is decoded", () => {
    const submission = Submission.decode(Contact, { name: "Ada", age: "36", subscribe: "true" })
    Vitest.expect(submission).toEqual(Exit.succeed({ name: "Ada", age: 36, subscribe: true }))
  })

  Vitest.it("reports every field's issues and keeps the submitted values", async () => {
    const values = { name: "", age: "old" }
    const submission = Submission.decode(Contact, values)
    const error = await Effect.runPromise(Effect.flip(submission))

    Vitest.expect(error).toBeInstanceOf(Submission.Invalid)
    Vitest.expect(error._tag).toBe("FormInvalid")
    Vitest.expect(error.values).toBe(values)
    Vitest.expect(error.errors).toEqual({
      name: ["Expected a value with a length of at least 1"],
      age: ["Expected a string representing a finite number"],
      subscribe: ["Required"]
    })
  })

  Vitest.it("is a payload schema that never fails to decode", () => {
    const decode = Schema.decodeUnknownSync(Submission.schema(Contact))
    Vitest.expect(Exit.isSuccess(decode({ name: "Ada", age: "36", subscribe: "false" }))).toBe(true)
    Vitest.expect(Exit.isFailure(decode({}))).toBe(true)
  })
})
