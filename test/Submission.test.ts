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
      age: ["Expected a string representing a finite number"]
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

  Vitest.it("reads unchecked checkboxes as false", async () => {
    const Preferences = Schema.Struct({
      newsletter: Schema.Boolean,
      digest: Schema.optionalKey(Schema.Boolean),
      terms: Schema.Literal(true).annotateKey({ messageMissingKey: "Accept the terms to continue" })
    })

    Vitest.expect(Submission.decode(Preferences, { terms: "true" }))
      .toEqual(Exit.succeed({ newsletter: false, terms: true }))
    Vitest.expect(Submission.decode(Preferences, { newsletter: "true", digest: "true", terms: "true" }))
      .toEqual(Exit.succeed({ newsletter: true, digest: true, terms: true }))

    const error = await invalid(Submission.decode(Preferences, {}))
    Vitest.expect(error.errors).toEqual({ terms: ["Accept the terms to continue"] })
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

  Vitest.describe("rules", () => {
    const Booking = Schema.Struct({
      name: Schema.NonEmptyString,
      nights: Schema.Int,
      guests: Schema.Int,
      promo: Schema.optionalKey(Schema.String)
    })
    const rules: Submission.Rules<typeof Booking.Type> = {
      guests: (s) => s.guests <= s.nights * 4 || "At most four guests per night",
      form: (s) => s.promo !== "SUMMER" || s.nights >= 3 || "SUMMER needs a stay of three nights or more"
    }

    Vitest.it("report alongside other fields' messages once the fields they read are valid", async () => {
      const error = await invalid(Submission.decode(Booking, { name: "", nights: "1", guests: "9", promo: "SUMMER" }, rules))
      Vitest.expect(error.errors).toEqual({ name: ["Required"], guests: ["At most four guests per night"] })
      Vitest.expect(error.formErrors).toEqual(["SUMMER needs a stay of three nights or more"])
    })

    Vitest.it("are skipped while a field they read is invalid", async () => {
      const error = await invalid(Submission.decode(Booking, { name: "Ada", nights: "many", guests: "9", promo: "SUMMER" }, rules))
      Vitest.expect(error.errors).toEqual({ nights: ["Expected a string representing a finite number"] })
      Vitest.expect(error.formErrors).toEqual([])
    })

    Vitest.it("read missing optional fields as undefined", () => {
      Vitest.expect(Submission.decode(Booking, { name: "Ada", nights: "1", guests: "2" }, rules))
        .toEqual(Exit.succeed({ name: "Ada", nights: 1, guests: 2 }))
    })

    Vitest.it("reject an otherwise valid submission", async () => {
      const error = await invalid(Submission.decode(Booking, { name: "Ada", nights: "1", guests: "5" }, rules))
      Vitest.expect(error.errors).toEqual({ guests: ["At most four guests per night"] })
    })

    Vitest.it("are keyed by fields or form", () => {
      // @ts-expect-error "room" is not a field
      const wrong: Submission.Rules<typeof Booking.Type> = { room: () => true }
      Vitest.expect(wrong).toBeDefined()
    })
  })

  Vitest.it("constructs Invalid with only the messages a handler has", () => {
    const error = new Submission.Invalid({ values: { title: "x" }, formErrors: ["Try again later"] })
    Vitest.expect(error.errors).toEqual({})
    Vitest.expect(error.formErrors).toEqual(["Try again later"])
  })

  Vitest.it("rejects a decoded value, encoding it back into form values", () => {
    const error = Submission.reject(Contact, { name: "Ada", age: 36, subscribe: false }, {
      errors: { name: ["Taken"] }
    })
    Vitest.expect(error.values).toEqual({ name: "Ada", age: "36", subscribe: "false" })
    Vitest.expect(error.errors).toEqual({ name: ["Taken"] })
    Vitest.expect(error.formErrors).toEqual([])
  })

  Vitest.it("is a URL-encoded payload schema that never fails to decode", () => {
    const decode = Schema.decodeUnknownSync(Submission.schema(Contact))
    Vitest.expect(Exit.isSuccess(decode({ name: "Ada", age: "36", subscribe: "false" }))).toBe(true)
    Vitest.expect(Exit.isFailure(decode({}))).toBe(true)
  })
})
