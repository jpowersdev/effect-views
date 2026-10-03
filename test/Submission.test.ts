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

const invalid = <A>(submission: Submission.Submission<A>) => Effect.runPromise(Effect.flip(submission))

Vitest.describe("Submission", () => {
  Vitest.it("decodes URL-encoded values as an HTTP form body is decoded", () => {
    const submission = Submission.decode(Contact, { name: "Ada", age: "36", subscribe: "true" })
    Vitest.expect(submission).toEqual(Exit.succeed({ name: "Ada", age: 36, subscribe: true }))
  })

  Vitest.it("reports every field's issues and keeps the submitted values", async () => {
    const values = { name: "", age: "old" }
    const error = await invalid(Submission.decode(Contact, values))

    Vitest.expect(error).toBeInstanceOf(Submission.Invalid)
    Vitest.expect(error._tag).toBe("FormInvalid")
    Vitest.expect(error.values).toBe(values)
    Vitest.expect(error.errors).toEqual({
      name: ["Required"],
      age: ["Expected a string representing a finite number"],
      subscribe: ["Required"]
    })
    Vitest.expect(error.formErrors).toEqual([])
  })

  Vitest.it("treats empty inputs as missing, so optional fields can be left blank", () => {
    const Profile = Schema.Struct({
      name: Schema.String,
      age: Schema.optionalKey(Schema.Int),
      tags: Schema.optionalKey(Schema.Array(Schema.String))
    })
    Vitest.expect(Submission.decode(Profile, { name: "Ada", age: "", tags: ["", ""] }))
      .toEqual(Exit.succeed({ name: "Ada" }))
  })

  Vitest.it("uses messages written in the schema", async () => {
    const Signup = Schema.Struct({
      // A message for each check, and for an empty or missing input
      username: Schema.Trim.check(
        Schema.isMinLength(3, { message: "Use at least 3 characters" }),
        Schema.isPattern(/^[a-z0-9]+$/, { message: "Use lowercase letters and numbers" })
      ).annotateKey({ messageMissingKey: "Choose a username" }),
      // One message for every problem with the field, including text that is not a number
      age: Schema.Int.check(Schema.isGreaterThanOrEqualTo(13)).annotate({ message: "Enter your age in years, 13 or over" })
    })

    const empty = await invalid(Submission.decode(Signup, { username: "", age: "" }))
    Vitest.expect(empty.errors).toEqual({ username: ["Choose a username"], age: ["Required"] })

    const wrong = await invalid(Submission.decode(Signup, { username: " A ", age: "twelve" }))
    Vitest.expect(wrong.errors).toEqual({
      username: ["Use at least 3 characters", "Use lowercase letters and numbers"],
      age: ["Enter your age in years, 13 or over"]
    })

    const young = await invalid(Submission.decode(Signup, { username: "ada", age: "12" }))
    Vitest.expect(young.errors).toEqual({ age: ["Enter your age in years, 13 or over"] })
  })

  Vitest.it("reports checks on the whole form as form errors", async () => {
    const ChangePassword = Schema.Struct({
      password: Schema.String,
      confirmation: Schema.String
    }).check(Schema.makeFilter(({ confirmation, password }) =>
      password === confirmation ? undefined : "The passwords do not match"
    ))

    const error = await invalid(Submission.decode(ChangePassword, { password: "a", confirmation: "b" }))
    Vitest.expect(error.errors).toEqual({})
    Vitest.expect(error.formErrors).toEqual(["The passwords do not match"])
  })

  Vitest.it("constructs Invalid with only the messages a handler has", () => {
    const error = new Submission.Invalid({ values: { title: "x" }, formErrors: ["Try again later"] })
    Vitest.expect(error.errors).toEqual({})
    Vitest.expect(error.formErrors).toEqual(["Try again later"])
  })

  Vitest.it("is a URL-encoded payload schema that never fails to decode", () => {
    const decode = Schema.decodeUnknownSync(Submission.schema(Contact))
    Vitest.expect(Exit.isSuccess(decode({ name: "Ada", age: "36", subscribe: "false" }))).toBe(true)
    Vitest.expect(Exit.isFailure(decode({}))).toBe(true)
  })
})
