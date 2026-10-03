import * as Data from "effect/Data"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"

/** Submitted form values, as strings, keyed by field name. */
export type Values = Readonly<Record<string, string | ReadonlyArray<string>>>

/** Error messages keyed by field name. */
export type Errors = Readonly<Record<string, ReadonlyArray<string>>>

/**
 * A submission that failed validation. Keeps the submitted values so a form can
 * be rendered again as the user left it.
 */
export class Invalid extends Data.TaggedError("FormInvalid")<{
  readonly values: Values
  readonly errors: Errors
}> {}

/**
 * The payload of an HttpFormEndpoint handler: an Exit, so `yield* payload` in
 * Effect.gen gives the decoded value or fails with Invalid.
 */
export type Submission<A> = Exit.Exit<A, Invalid>

const leafHook: SchemaIssue.LeafHook = (issue) =>
  issue._tag === "MissingKey" ? "Required" : SchemaIssue.defaultLeafHook(issue)

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook })

/** Groups schema issues by their top-level field. */
export const errorsFromIssue = (issue: SchemaIssue.Issue): Errors => {
  const errors: Record<string, Array<string>> = {}
  for (const { message, path } of formatIssue(issue).issues) {
    const segment = path?.[0]
    const key = typeof segment === "object" && segment !== null ? segment.key : segment
    const name = key === undefined ? "" : String(key)
    ;(errors[name] ??= []).push(message)
  }
  return errors
}

// Form fields decode without services; the casts drop the generic service parameters.
const stringTreeCodec = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  Schema.toCodecStringTree(schema) as unknown as Schema.Codec<Schema.Struct<Fields>["Type"], unknown>

const RawValues = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))

/**
 * Decodes URL-encoded values with a Struct schema, as an HTTP form body is
 * decoded, reporting every field's issues.
 */
export const decode = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  values: Values
): Submission<Schema.Struct<Fields>["Type"]> => {
  const result = Schema.decodeUnknownResult(stringTreeCodec(schema))(values, { errors: "all" })
  return Result.isSuccess(result)
    ? Exit.succeed(result.success)
    : Exit.fail(new Invalid({ values, errors: errorsFromIssue(result.failure.issue) }))
}

/**
 * A URL-encoded payload schema that never fails to decode: it produces a
 * Submission, so the handler decides how to present invalid input.
 */
export const schema = <Fields extends Schema.Struct.Fields>(struct: Schema.Struct<Fields>) => {
  type Type = Schema.Struct<Fields>["Type"]
  const encode = Schema.encodeSync(stringTreeCodec(struct))
  const isSubmission = (input: unknown): input is Submission<Type> => Exit.isExit(input)
  const SubmissionDeclaration = Schema.declare<Submission<Type>>(isSubmission, {
    identifier: "Submission",
    description: "A decoded form submission, or the values and errors of an invalid one"
  })

  return RawValues.pipe(
    Schema.decodeTo(
      SubmissionDeclaration,
      SchemaTransformation.transform({
        decode: (values) => decode(struct, values),
        encode: (submission) =>
          Exit.isSuccess(submission)
            ? encode(submission.value) as typeof RawValues.Type
            : Option.match(Exit.findErrorOption(submission), {
              onNone: () => ({}),
              onSome: (invalid) => invalid.values as typeof RawValues.Type
            })
      })
    )
  )
}
