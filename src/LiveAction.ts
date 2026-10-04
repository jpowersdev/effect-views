import * as Schema from "effect/Schema"

export const TypeId = "~effect-views/LiveAction" as const

/**
 * An action of a live component, declared apart from its handler: its name,
 * and the payload it decodes from the inputs in the component. Add it to a
 * component with LiveComponent.make(...).add, and implement it with
 * LiveComponent.handlers.
 */
export interface LiveAction<Name extends string, Fields extends Schema.Struct.Fields> {
  readonly [TypeId]: typeof TypeId
  readonly name: Name
  readonly payload: Schema.Struct<Fields>
  /** A summary of the action, for the OpenAPI document. */
  readonly description: string | undefined
}

export type Any = LiveAction<string, any>

/** The decoded payload of an action. */
export type Payload<Action> = Action extends LiveAction<any, infer Fields> ? Schema.Struct<Fields>["Type"] : never

export interface Options<Fields extends Schema.Struct.Fields> {
  /** Fields decoded like a form from the inputs in the component, and values given where the action is used. */
  readonly payload?: Fields
  /** A summary of the action, for the OpenAPI document, such as "Search todos". */
  readonly description?: string
}

/**
 * Declares an action.
 *
 * ```ts
 * export const search = LiveAction.make("search", {
 *   payload: { query: Schema.optionalKey(Schema.String) }
 * })
 * ```
 */
export const make = <const Name extends string, const Fields extends Schema.Struct.Fields = {}>(
  name: Name,
  options?: Options<Fields>
): LiveAction<Name, Fields> => {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new TypeError(`An action's name must be a letter followed by letters, digits, "_", or "-": ${name}`)
  }
  return Object.freeze({
    [TypeId]: TypeId,
    name,
    payload: Schema.Struct(options?.payload ?? ({} as Fields)),
    description: options?.description
  })
}
