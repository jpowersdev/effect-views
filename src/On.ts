/**
 * Event bindings for live components. A binding is data in an attribute, such
 * as `data-on-click='[…]'`, which the effect-views runtime reads when the event
 * happens: there is no code in the markup, so it works under a strict content
 * security policy.
 *
 * ```tsx
 * <input value={state.query} {...On.input(actions.type({ query: On.value }))} />
 * <li {...On.click(actions.choose({ index }))}>{person.name}</li>
 * ```
 */

const PlaceholderTypeId = "~effect-views/On/Placeholder" as const

/**
 * A value read from the element when the event happens, in place of a value
 * known when rendering; see value and checked.
 */
export interface Placeholder<out A> {
  readonly [PlaceholderTypeId]: "value" | "checked"
  readonly "~type"?: A
}

/** The value of the element the binding is on, such as what was typed in an input. */
export const value: Placeholder<string> = { [PlaceholderTypeId]: "value" }

/** Whether the checkbox or radio button the binding is on is checked. */
export const checked: Placeholder<boolean> = { [PlaceholderTypeId]: "checked" }

export const isPlaceholder = (input: unknown): input is Placeholder<unknown> =>
  typeof input === "object" && input !== null && PlaceholderTypeId in input

/** @internal The kind of a placeholder, as it appears in a binding. */
export const placeholderKind = (placeholder: Placeholder<unknown>): "value" | "checked" =>
  placeholder[PlaceholderTypeId]

/**
 * Something for the runtime to do when an event happens: running one of the
 * component's actions, as made by the `actions` a view's render receives.
 */
export type Command = BrowserAction | ServerAction

/** An action of a component that runs in the browser, run by its handler there. */
export interface BrowserAction {
  readonly _tag: "Action"
  readonly action: string
  /** The action's values, encoded, with placeholders where they are read from the element. */
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * An action of a component that runs on the server: the runtime posts the
 * inputs in the component, with its signed state, to the action's endpoint,
 * and updates the component with the HTML it returns.
 */
export interface ServerAction {
  readonly _tag: "Server"
  readonly action: string
  readonly url: string
  /** Values given where the action is used, encoded like a form's; they replace inputs of the same name. */
  readonly payload: Readonly<Record<string, string | ReadonlyArray<string>>>
  readonly concurrency: "switch" | "parallel"
  /** Milliseconds to wait for events to stop before posting. */
  readonly debounce?: number
}

/**
 * The events the runtime handles: it listens for each once, on the document,
 * so only events that bubble are here. Use focusin and focusout rather than
 * focus and blur, and pointerover and pointerout rather than enter and leave.
 */
export const events = [
  "click",
  "dblclick",
  "contextmenu",
  "input",
  "change",
  "submit",
  "keydown",
  "keyup",
  "focusin",
  "focusout",
  "pointerdown",
  "pointerup",
  "pointerover",
  "pointerout",
  "dragstart",
  "dragend",
  "dragover",
  "drop"
] as const

export type EventName = typeof events[number]

/** Attributes binding an event to commands; spread them onto an element. */
export type Binding<Event extends string> = { readonly [K in `data-on-${Event}`]: string }

/** Runs commands when the event happens on the element or inside it. */
export const event = <const Event extends EventName>(name: Event, ...commands: ReadonlyArray<Command>): Binding<Event> => {
  if (!(events as ReadonlyArray<string>).includes(name)) {
    throw new TypeError(`The runtime does not handle "${name}" events; use one of: ${events.join(", ")}`)
  }
  return { [`data-on-${name}`]: JSON.stringify(commands) } as Binding<Event>
}

export const click = (...commands: ReadonlyArray<Command>): Binding<"click"> => event("click", ...commands)
export const input = (...commands: ReadonlyArray<Command>): Binding<"input"> => event("input", ...commands)
export const change = (...commands: ReadonlyArray<Command>): Binding<"change"> => event("change", ...commands)
/** Runs commands instead of submitting the form. */
export const submit = (...commands: ReadonlyArray<Command>): Binding<"submit"> => event("submit", ...commands)
export const focusin = (...commands: ReadonlyArray<Command>): Binding<"focusin"> => event("focusin", ...commands)
export const focusout = (...commands: ReadonlyArray<Command>): Binding<"focusout"> => event("focusout", ...commands)

/**
 * Keys, by `KeyboardEvent.key`, such as "Enter" or "ArrowDown", and what each
 * runs. A key left out, or given undefined, keeps its usual behaviour; a key
 * in the map does not, so Enter in a form does not submit it.
 */
export type Keys = Readonly<Record<string, Command | ReadonlyArray<Command> | undefined>>

const keyBinding = <const Event extends "keydown" | "keyup">(name: Event, keys: Keys): Binding<Event> => {
  const bound: Record<string, ReadonlyArray<Command>> = {}
  for (const [key, commands] of Object.entries(keys)) {
    if (commands !== undefined) bound[key] = Array.isArray(commands) ? commands : [commands as Command]
  }
  return { [`data-on-${name}`]: JSON.stringify(bound) } as Binding<Event>
}

export const keydown = (keys: Keys): Binding<"keydown"> => keyBinding("keydown", keys)
export const keyup = (keys: Keys): Binding<"keyup"> => keyBinding("keyup", keys)
