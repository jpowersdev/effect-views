import * as Data from "effect/Data"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"

/** Submitted form values, as strings, keyed by field name. */
export type Values = Readonly<Record<string, string | ReadonlyArray<string>>>

/** Error messages keyed by field name. */
export type Errors = Readonly<Record<string, ReadonlyArray<string>>>

/**
 * A submission that failed validation. Keeps the submitted values so a form can
 * be rendered again as the user left it, with messages for each field and for
 * the form as a whole.
 */
export class Invalid extends Data.TaggedError("FormInvalid")<{
  readonly values: Values
  readonly errors: Errors
  readonly formErrors: ReadonlyArray<string>
}> {
  constructor(props: {
    readonly values: Values
    readonly errors?: Errors
    readonly formErrors?: ReadonlyArray<string>
  }) {
    super({ values: props.values, errors: props.errors ?? {}, formErrors: props.formErrors ?? [] })
  }
}

/**
 * The payload of a form endpoint's handler: an Exit, so `yield* payload` in
 * Effect.gen gives the decoded value or fails with Invalid.
 */
export type Submission<A> = Exit.Exit<A, Invalid>

const leafHook: SchemaIssue.LeafHook = (issue) =>
  issue._tag === "MissingKey"
    ? issue.annotations?.messageMissingKey ?? "Required"
    : SchemaIssue.defaultLeafHook(issue)

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook })

const resolveMessage = SchemaAST.resolveAt<string>("message")

const messagesOf = (issue: SchemaIssue.Issue): Array<string> =>
  formatIssue(issue).issues.map(({ message }) => message)

/**
 * A field's messages. Failures to convert the submitted string, such as "abc"
 * for a number, sit under an Encoding issue; the field's own message, when it
 * has one, replaces them.
 */
const fieldMessages = (issue: SchemaIssue.Issue, message: string | undefined): Array<string> => {
  if (issue._tag === "Encoding" && message !== undefined) return [message]
  if (issue._tag === "Composite") return issue.issues.flatMap((child) => fieldMessages(child, message))
  return messagesOf(issue)
}

// Form fields decode without services; the casts drop the generic service parameters.
const stringTreeCodec = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  Schema.toCodecStringTree(schema) as unknown as Schema.Codec<Schema.Struct<Fields>["Type"], unknown>

/** An empty input is a missing value, as it is for HTML forms. */
const withoutEmpty = (values: Values): Values => {
  const present: Record<string, string | ReadonlyArray<string>> = {}
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") {
      if (value !== "") present[name] = value
    } else {
      const items = value.filter((item) => item !== "")
      if (items.length > 0) present[name] = items
    }
  }
  return present
}

/**
 * Decodes URL-encoded values with a Struct schema, as an HTTP form body is
 * decoded, reporting every field's issues.
 *
 * - Empty inputs count as missing: required fields report "Required", or their
 *   `messageMissingKey` annotation, and optional fields are left out.
 * - A field's `message` annotation, such as `Schema.Int.annotate({ message })`,
 *   also replaces the message for text that cannot be converted, such as "abc"
 *   for a number.
 * - Issues without a field, such as those from a check on the whole Struct,
 *   become form errors.
 */
export const decode = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  values: Values
): Submission<Schema.Struct<Fields>["Type"]> => {
  const present = withoutEmpty(values)
  const result = Schema.decodeUnknownResult(stringTreeCodec(schema))(present, { errors: "all" })
  if (Result.isSuccess(result)) return Exit.succeed(result.success)

  const errors: Record<string, Array<string>> = {}
  const formErrors: Array<string> = []
  const add = (name: string, messages: ReadonlyArray<string>) => {
    const list = errors[name] ??= []
    for (const message of messages) if (!list.includes(message)) list.push(message)
  }

  const root = result.failure.issue
  for (const issue of root._tag === "Composite" ? root.issues : [root]) {
    if (issue._tag === "Pointer" && issue.path.length > 0) {
      const name = String(issue.path[0])
      const field: Schema.Constraint | undefined = Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined
      const message = field === undefined ? undefined : resolveMessage(field.ast)
      add(name, issue.path.length === 1 ? fieldMessages(issue.issue, message) : messagesOf(issue))
      continue
    }
    // Checks on the whole Struct have no field, unless they point at one.
    for (const { message, path } of formatIssue(issue).issues) {
      const segment = path?.[0]
      const key = typeof segment === "object" && segment !== null ? segment.key : segment
      if (key === undefined) formErrors.push(message)
      else add(String(key), [message])
    }
  }
  return Exit.fail(new Invalid({ values, errors, formErrors }))
}

const RawValues = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))

/**
 * A URL-encoded payload schema that never fails to decode: it produces a
 * Submission, so the handler decides how to present invalid input. Use it as
 * the payload of any endpoint that receives a form.
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
    ),
    HttpApiSchema.asFormUrlEncoded()
  )
}
