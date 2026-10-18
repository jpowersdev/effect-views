import * as Schema from "effect/Schema"

export const TypeId = "~effect-views/LiveAction" as const

/**
 * An action of a live component, declared apart from its handler: its name,
 * and the payload it decodes. Add it to a component with
 * LiveComponent.make(...).add, and implement it with LiveComponent.server or
 * LiveComponent.browser, depending on where the component runs.
 */
export interface LiveAction<Name extends string, Fields extends Schema.Struct.Fields> {
  readonly [TypeId]: typeof TypeId
  readonly name: Name
  readonly payload: Schema.Struct<Fields>
  /** A summary of the action, for the OpenAPI document. */
  readonly description: string | undefined
  /** What happens when the action runs again before the last run finishes; see Options. */
  readonly concurrency: Concurrency
}

/**
 * "switch" interrupts the run in progress when the action runs again, so only
 * the latest one finishes, such as a search as you type. "parallel" lets runs
 * overlap.
 */
export type Concurrency = "switch" | "parallel"

export type Any = LiveAction<string, any>

/** The decoded payload of an action. */
export type Payload<Action> = Action extends LiveAction<any, infer Fields> ? Schema.Struct<Fields>["Type"] : never

/** The encoded payload of an action, as its values are sent. */
export type Encoded<Action> = Action extends LiveAction<any, infer Fields> ? Schema.Struct<Fields>["Encoded"] : never

export interface Options<Fields extends Schema.Struct.Fields> {
  /** Fields decoded like a form from the inputs in the component, and values given where the action is used. */
  readonly payload?: Fields
  /** A summary of the action, for the OpenAPI document, such as "Search todos". */
  readonly description?: string
  /**
   * What happens when the action runs again before the last run finishes.
   * Defaults to "parallel". With "switch", only the latest run finishes: in the
   * browser the earlier fiber is interrupted, which also aborts its requests,
   * and on the server htmx drops the earlier request. Waiting first with
   * `Effect.sleep` then debounces the action.
   */
  readonly concurrency?: Concurrency
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
    description: options?.description,
    concurrency: options?.concurrency ?? "parallel"
  })
}
