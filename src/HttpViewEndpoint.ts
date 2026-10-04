import * as Schema from "effect/Schema"
import type * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as OpenApi from "effect/http-api/OpenApi"

import * as Html from "./Html.js"

type InputSchema = Schema.Top | Schema.Struct.Fields

type ReadOptions<Params extends InputSchema, Query extends InputSchema, Headers extends InputSchema> = {
  readonly params?: Params
  readonly query?: Query
  readonly headers?: Headers
}

type WriteOptions<
  Method extends "POST" | "PUT" | "PATCH" | "DELETE",
  Params extends InputSchema,
  Query extends InputSchema,
  Payload extends HttpApiEndpoint.PayloadConstraintCodecs<Method>,
  Headers extends InputSchema
> = ReadOptions<Params, Query, Headers> & {
  readonly payload?: Payload
}

/** Declares a GET endpoint with Html.schema as its success schema. */
export function get<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options?: ReadOptions<Params, Query, Headers>
) {
  return HttpApiEndpoint.get(identifier, path, { ...options, success: Html.schema })
}

/** Declares a POST endpoint with Html.schema as its success schema. */
export function post<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Payload extends HttpApiEndpoint.PayloadConstraintCodecs<"POST"> = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options?: WriteOptions<"POST", Params, Query, Payload, Headers>
) {
  return HttpApiEndpoint.post(identifier, path, { ...options, success: Html.schema })
}

/** Declares a PUT endpoint with Html.schema as its success schema. */
export function put<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Payload extends HttpApiEndpoint.PayloadConstraintCodecs<"PUT"> = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options?: WriteOptions<"PUT", Params, Query, Payload, Headers>
) {
  return HttpApiEndpoint.put(identifier, path, { ...options, success: Html.schema })
}

/** Declares a PATCH endpoint with Html.schema as its success schema. */
export function patch<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Payload extends HttpApiEndpoint.PayloadConstraintCodecs<"PATCH"> = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options?: WriteOptions<"PATCH", Params, Query, Payload, Headers>
) {
  return HttpApiEndpoint.patch(identifier, path, { ...options, success: Html.schema })
}

/** Declares a DELETE endpoint with Html.schema as its success schema. */
export function del<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Payload extends HttpApiEndpoint.PayloadConstraintCodecs<"DELETE"> = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options?: WriteOptions<"DELETE", Params, Query, Payload, Headers>
) {
  return HttpApiEndpoint.delete(identifier, path, { ...options, success: Html.schema })
}

/**
 * An HTML fragment sent as a server-sent event. htmx swaps it into the
 * elements that listen for its name; see View.derive's Subscribe.
 */
export const HtmlEvent = Schema.Struct({
  id: Schema.optional(Schema.String),
  event: Schema.String,
  data: Html.FromString
})
export type HtmlEvent = typeof HtmlEvent.Type

/**
 * Declares a GET endpoint that streams HTML fragments as server-sent events.
 * Its handler returns a Stream of HtmlEvent; the connection stays open until
 * the browser closes it.
 *
 * ```ts
 * export const changes = HttpViewEndpoint.events("changes", "/todos/changes")
 *
 * .handle("changes", () =>
 *   Effect.succeed(todos.changes.pipe(Stream.map((items) => ({ event: "todos", data: <TodoList todos={items} /> })))))
 * ```
 */
export function events<
  const Identifier extends string,
  const Path extends HttpRouter.PathInput,
  Params extends InputSchema = never,
  Query extends InputSchema = never,
  Headers extends InputSchema = never
>(
  identifier: Identifier,
  path: Path,
  options?: ReadOptions<Params, Query, Headers>
) {
  return HttpApiEndpoint.get(identifier, path, {
    ...options,
    success: HttpApiSchema.StreamSse({ events: HtmlEvent })
  }).annotate(OpenApi.Override, {
    // A label beside the operation in Scalar's reference
    "x-badges": [{ name: "Event stream", position: "before" }]
  })
}

/** Marks a schema as an application/x-www-form-urlencoded request payload. */
export const form = <S extends Schema.Top>(schema: S) =>
  schema.pipe(HttpApiSchema.asFormUrlEncoded())
