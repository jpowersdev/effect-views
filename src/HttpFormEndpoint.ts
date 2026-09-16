import type * as Schema from "effect/Schema"
import type * as HttpRouter from "effect/unstable/http/HttpRouter"
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"

import * as HttpViewEndpoint from "./HttpViewEndpoint.js"

export const TypeId = "~effect-views/HttpFormEndpoint" as const

type InputSchema = Schema.Top | Schema.Struct.Fields

export interface Metadata<Fields extends Schema.Struct.Fields> {
  readonly payload: Schema.Struct<Fields>
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
  readonly params?: Params
  readonly query?: Query
  readonly headers?: Headers
}

/**
 * Creates a POST view endpoint with a URL-encoded Struct payload and Html response.
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
  const { payload, ...request } = options
  const endpoint = HttpViewEndpoint.post(identifier, path, {
    ...request,
    payload: HttpViewEndpoint.form(payload)
  })

  Object.defineProperty(endpoint, TypeId, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ payload })
  })

  return endpoint as typeof endpoint & {
    readonly [TypeId]: Metadata<FormFields>
  }
}

export const isHttpFormEndpoint = (value: unknown): value is Any =>
  value !== null &&
  (typeof value === "function" || typeof value === "object") &&
  TypeId in value

export const getPayload = <Endpoint extends Any>(
  endpoint: Endpoint
): Schema.Struct<Fields<Endpoint>> =>
  endpoint[TypeId].payload as Schema.Struct<Fields<Endpoint>>
