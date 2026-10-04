import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import type * as HttpRouter from "effect/http/HttpRouter"
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as OpenApi from "effect/http-api/OpenApi"

import * as HttpViewEndpoint from "./HttpViewEndpoint.js"
import * as Submission from "./Submission.js"

export const TypeId = "~effect-views/HttpFormEndpoint" as const

type InputSchema = Schema.Top | Schema.Struct.Fields

/**
 * The form's fields as they are submitted, for the OpenAPI document. A form's
 * payload decodes from any URL-encoded values, so that invalid input reaches
 * the handler; the document describes the fields the form expects instead.
 */
const requestBody = (payload: Schema.Struct<Schema.Struct.Fields>) => {
  // The fields alone, so that a named payload is described in place rather than referred to
  const fields = Schema.Struct(payload.fields)
  const document = Schema.toJsonSchemaDocument(Schema.toCodecStringTree(fields) as unknown as Schema.Top)
  // Fields that refer to named schemas would need those definitions in the document too
  if (Object.keys(document.definitions).length > 0) return undefined
  // Other fields are allowed without saying so, which documentation tools would show as a field of its own
  const { additionalProperties: _, ...schema } = document.schema as Record<string, unknown>
  return {
    required: true,
    content: { "application/x-www-form-urlencoded": { schema } }
  }
}

export interface Metadata<Fields extends Schema.Struct.Fields> {
  readonly payload: Schema.Struct<Fields>
  readonly rules: Submission.Rules<Schema.Struct<Fields>["Type"]> | undefined
}

export interface EndpointLike extends HttpApiEndpoint.Constraint {
  readonly path: string
}

export type HttpFormEndpoint<
  Fields extends Schema.Struct.Fields,
  Endpoint extends EndpointLike
> = Endpoint & {
  readonly [TypeId]: Metadata<Fields>
}

export type Any = HttpFormEndpoint<any, EndpointLike>

export type Fields<Endpoint> = Endpoint extends {
  readonly [TypeId]: Metadata<infer FormFields>
} ? FormFields
  : never

export interface Options<
  FormFields extends Schema.Struct.Fields,
  Params extends InputSchema,
  Query extends InputSchema,
  Headers extends InputSchema
> {
  readonly payload: Schema.Struct<FormFields>
  /** Rules about the decoded values; see Submission.Rules. */
  readonly rules?: Submission.Rules<NoInfer<Schema.Struct<FormFields>["Type"]>>
  readonly params?: Params
  readonly query?: Query
  readonly headers?: Headers
  /**
   * Annotations for the endpoint, such as `OpenApi.annotations({ summary })`.
   * Pass them here: annotating the endpoint afterwards loses Form.derive's metadata.
   */
  readonly annotations?: Context.Context<never>
}

/**
 * Creates a POST view endpoint with a URL-encoded Struct payload and Html response.
 * The handler's payload is a Submission: yield it for the decoded value, or
 * handle Submission.Invalid to show the form again with its errors.
 * Attaches the original Struct as metadata for Form.derive. Effect's endpoint
 * transformations (such as prefix) do not preserve this metadata.
 */
export function make<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  const FormFields extends Schema.Struct.Fields,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options: Options<FormFields, Params, Query, Headers>
) {
  const { annotations, payload, rules, ...request } = options
  const declared = HttpViewEndpoint.post(identifier, path, {
    ...request,
    payload: Submission.schema(payload, { rules })
  })
  const body = requestBody(payload)
  const override = {
    ...(body === undefined ? {} : { requestBody: body }),
    ...(annotations === undefined ? {} : Context.getOrElse(annotations, OpenApi.Override, () => ({})))
  }
  const endpoint = declared
    .annotateMerge(annotations ?? Context.empty())
    .annotate(OpenApi.Override, override)

  Object.defineProperty(endpoint, TypeId, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ payload, rules })
  })

  return endpoint as typeof endpoint & {
    readonly [TypeId]: Metadata<FormFields>
  }
}

export const isHttpFormEndpoint = (value: unknown): value is Any =>
  value !== null &&
  (typeof value === "function" || typeof value === "object") &&
  TypeId in value

export const getRules = <Endpoint extends Any>(
  endpoint: Endpoint
): Submission.Rules<Schema.Struct<Fields<Endpoint>>["Type"]> | undefined =>
  endpoint[TypeId].rules as Submission.Rules<Schema.Struct<Fields<Endpoint>>["Type"]> | undefined

export const getPayload = <Endpoint extends Any>(
  endpoint: Endpoint
): Schema.Struct<Fields<Endpoint>> =>
  endpoint[TypeId].payload as Schema.Struct<Fields<Endpoint>>
