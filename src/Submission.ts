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

/** An unchecked checkbox is not submitted at all; a required boolean field reads it as false. */
const withUncheckedBooleans = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  values: Values
): Values => {
  const filled: Record<string, string | ReadonlyArray<string>> = { ...values }
  for (const [name, field] of Object.entries(schema.fields) as Array<[string, Schema.Constraint]>) {
    if (!Object.hasOwn(filled, name) && field.ast._tag === "Boolean" && field.ast.context?.isOptional !== true) {
      filled[name] = "false"
    }
  }
  return filled
}

/**
 * What a rule returns: true (or undefined) when the values are acceptable, a
 * message for the form as a whole, or a message for one field.
 */
export type Outcome<A> =
  | true
  | undefined
  | string
  | { readonly field: Extract<keyof A, string>; readonly message: string }

/** A rule about some fields of a form, created with the builder given to Rules. */
export interface Rule<A> {
  readonly fields: ReadonlyArray<string>
  readonly check: (values: never) => Outcome<A>
}

export interface RuleBuilder<A> {
  /**
   * A rule reading the listed fields, which it receives decoded. It runs once
   * all of them are valid, even if other fields are not, and is skipped while
   * any of them is invalid.
   */
  <const Names extends Extract<keyof A, string>>(
    fields: ReadonlyArray<Names>,
    check: (values: Pick<A, Names>) => Outcome<A>
  ): Rule<A>
}

/**
 * Rules across fields, such as matching passwords:
 *
 * ```ts
 * rules: (rule) => [
 *   rule(["password", "confirmation"], (s) =>
 *     s.password === s.confirmation || { field: "confirmation", message: "The passwords do not match" })
 * ]
 * ```
 */
export type Rules<A> = (rule: RuleBuilder<A>) => ReadonlyArray<Rule<A>>

const ruleBuilder: RuleBuilder<any> = (fields, check) => ({ fields, check: check as Rule<any>["check"] })

const runRules = <A>(
  rules: Rules<A>,
  decoded: Readonly<Record<string, unknown>>,
  failed: ReadonlySet<string>,
  report: (name: string | undefined, message: string) => void
) => {
  for (const { check, fields } of rules(ruleBuilder)) {
    if (fields.some((name) => failed.has(name))) continue
    const values: Record<string, unknown> = {}
    for (const name of fields) if (Object.hasOwn(decoded, name)) values[name] = decoded[name]
    const outcome = (check as (values: Record<string, unknown>) => Outcome<A>)(values)
    if (typeof outcome === "string") report(undefined, outcome)
    else if (typeof outcome === "object") report(outcome.field, outcome.message)
  }
}

/** Decodes each field on its own, to find the values rules may read when the whole form is invalid. */
const decodeFields = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>, present: Values) => {
  const decoded: Record<string, unknown> = {}
  const failed = new Set<string>()
  for (const [name, field] of Object.entries(schema.fields) as Array<[string, Schema.Top]>) {
    const single = Schema.Struct({ [name]: field }) as Schema.Struct<Schema.Struct.Fields>
    const input = Object.hasOwn(present, name) ? { [name]: present[name] } : {}
    const result = Schema.decodeUnknownResult(stringTreeCodec(single))(input)
    if (Result.isFailure(result)) failed.add(name)
    else if (Object.hasOwn(result.success, name)) decoded[name] = result.success[name]
  }
  return { decoded, failed }
}

/**
 * Decodes URL-encoded values with a Struct schema, as an HTTP form body is
 * decoded, reporting every field's issues.
 *
 * - Empty inputs count as missing: required fields report "Required", or their
 *   `messageMissingKey` annotation, and optional fields are left out.
 * - A missing required `Schema.Boolean` is false, as for an unchecked checkbox.
 *   Optional booleans stay missing, and `Schema.Literal(true)` still requires a
 *   checked box.
 * - A field's `message` annotation, such as `Schema.Int.annotate({ message })`,
 *   also replaces the message for text that cannot be converted, such as "abc"
 *   for a number.
 * - Issues without a field, such as those from a check on the whole Struct,
 *   become form errors.
 * - Rules run once the fields they list have decoded; see Rules.
 */
export const decode = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  values: Values,
  rules?: Rules<Schema.Struct<Fields>["Type"]>
): Submission<Schema.Struct<Fields>["Type"]> => {
  const present = withUncheckedBooleans(schema, withoutEmpty(values))
  const result = Schema.decodeUnknownResult(stringTreeCodec(schema))(present, { errors: "all" })
  if (Result.isSuccess(result) && rules === undefined) return Exit.succeed(result.success)

  const errors: Record<string, Array<string>> = {}
  const formErrors: Array<string> = []
  const add = (name: string, messages: ReadonlyArray<string>) => {
    const list = errors[name] ??= []
    for (const message of messages) if (!list.includes(message)) list.push(message)
  }

  const issues = Result.isSuccess(result)
    ? []
    : result.failure.issue._tag === "Composite" ? result.failure.issue.issues : [result.failure.issue]
  for (const issue of issues) {
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

  if (rules !== undefined) {
    const { decoded, failed } = Result.isSuccess(result)
      ? { decoded: result.success as Record<string, unknown>, failed: new Set<string>() }
      : decodeFields(schema, present)
    runRules(rules, decoded, failed, (name, message) => {
      if (name === undefined) {
        if (!formErrors.includes(message)) formErrors.push(message)
      } else add(name, [message])
    })
  }

  if (Result.isSuccess(result) && formErrors.length === 0 && Object.keys(errors).length === 0) {
    return Exit.succeed(result.success)
  }
  return Exit.fail(new Invalid({ values, errors, formErrors }))
}

export interface Messages {
  readonly errors?: Errors
  readonly formErrors?: ReadonlyArray<string>
}

/**
 * Rejects a decoded value, for rules checked after decoding, such as an email
 * address already in use. The value is encoded back into form values so the
 * form can be shown again as it was submitted.
 */
export const reject = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  value: Schema.Struct<Fields>["Type"],
  messages: Messages
): Invalid =>
  new Invalid({ values: Schema.encodeSync(stringTreeCodec(schema))(value) as Values, ...messages })

const RawValues = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
  description: "The values of a submitted form, by field name"
})

/**
 * A URL-encoded payload schema that never fails to decode: it produces a
 * Submission, so the handler decides how to present invalid input. Use it as
 * the payload of any endpoint that receives a form.
 */
export const schema = <Fields extends Schema.Struct.Fields>(
  struct: Schema.Struct<Fields>,
  options?: { readonly rules?: Rules<Schema.Struct<Fields>["Type"]> | undefined }
) => {
  type Type = Schema.Struct<Fields>["Type"]
  const encode = Schema.encodeSync(stringTreeCodec(struct))
  const isSubmission = (input: unknown): input is Submission<Type> => Exit.isExit(input)
  // Unnamed, so the OpenAPI document does not list the generic values as a model; HttpFormEndpoint describes each form's fields
  const SubmissionDeclaration = Schema.declare<Submission<Type>>(isSubmission, {
    description: "A decoded form submission, or the values and errors of an invalid one"
  })

  return RawValues.pipe(
    Schema.decodeTo(
      SubmissionDeclaration,
      SchemaTransformation.transform({
        decode: (values) => decode(struct, values, options?.rules),
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
