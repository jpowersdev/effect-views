/**
 * The effect-views runtime for live components that run in the browser.
 * Assets.layer bundles it with each component's module, and the page head
 * loads it. It finds each component's element, loads the component's module,
 * runs its actions when the events bound with On happen, and renders the
 * component again when its state changes.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberMap from "effect/FiberMap"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"

import * as Html from "../Html.js"
import * as LiveComponent from "../LiveComponent.js"
import * as On from "../On.js"
import { morphChildren } from "./morph.js"

const selector = "[data-live-module]"

/** The events On binds; each is handled once, on the document. */
const events = ["click", "input", "change", "submit", "keydown", "keyup", "focusin", "focusout"] as const

interface Instance {
  /** Runs an action with its values; actions that arrive before the component's module loads wait for it. */
  readonly run: (action: string, values: Record<string, unknown>) => void
  readonly close: () => void
}

const instances = new WeakMap<Element, Instance>()

// State and payloads decode without services; the cast drops the generic service parameters.
const jsonCodec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
  Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>

const report = (tag: string, message: string, cause?: unknown): void => {
  console.error(`<${tag}> ${message}`, ...(cause === undefined ? [] : [cause]))
}

/** Values that do not decode, such as an empty number field, are ignored: the action does not run. */
const ignored = (tag: string, action: string, cause: unknown): void => {
  console.warn(`<${tag}> ${action} did not run: its values do not match its payload`, cause)
}

interface Shared {
  /** Builds each layer once per page, so components that provide the same layer share its services. */
  readonly memoMap: Layer.MemoMap
  /** The page's lifetime, which those services last for. */
  readonly scope: Scope.Scope
}

const mount = (element: HTMLElement, shared: Shared): void => {
  const tag = element.localName
  const waiting: Array<readonly [string, Record<string, unknown>]> = []
  let dispatch: ((action: string, values: Record<string, unknown>) => void) | undefined
  const scope = Effect.runSync(Scope.make())
  instances.set(element, {
    run: (action, values) => {
      if (dispatch === undefined) waiting.push([action, values])
      else dispatch(action, values)
    },
    // Interrupts the component's actions and stops rendering it
    close: () => {
      Effect.runFork(Scope.close(scope, Exit.void))
    }
  })

  const start = Effect.gen(function* () {
    const module = element.getAttribute("data-live-module") ?? ""
    yield* Effect.promise(() => import(module))
    const definition = LiveComponent.browserDefinition(tag)
    if (definition === undefined) {
      return yield* Effect.die(new Error(`${module} did not call LiveComponent.browser for <${tag}>`))
    }
    const { component, implementation, layer, view } = definition
    const initial = yield* Schema.decodeUnknownEffect(jsonCodec(component.state))(
      JSON.parse(element.getAttribute("data-live-state") ?? "null")
    )
    const ref = yield* SubscriptionRef.make<unknown>(initial)
    const context = layer === undefined
      ? Context.empty()
      : yield* Layer.buildWithMemoMap(shared.memoMap, shared.scope)(layer as Layer.Layer<unknown>)
    // "switch" actions replace their own earlier run; the others run side by side
    const runLatest = yield* FiberMap.makeRuntime<never, string>()
    const runAll = yield* FiberSet.makeRuntime<never>()

    // The page already shows the initial state; after that, render at most once a frame, from the latest state
    let shown = initial
    let latest = initial
    let scheduled = false
    yield* SubscriptionRef.changes(ref).pipe(
      Stream.runForEach((state) =>
        Effect.sync(() => {
          latest = state
          if (scheduled || latest === shown) return
          scheduled = true
          requestAnimationFrame(() => {
            scheduled = false
            if (latest === shown) return
            shown = latest
            morphChildren(element, Html.render(view.contents(latest)))
          })
        })
      ),
      Effect.forkScoped
    )

    const state: LiveComponent.StateRef<unknown> = {
      get: SubscriptionRef.get(ref),
      set: (next) => SubscriptionRef.set(ref, next),
      update: (f) => SubscriptionRef.update(ref, f)
    }

    dispatch = (name, values) => {
      const action = component.actions[name]
      const handler = implementation[name]
      if (action === undefined || handler === undefined) return report(tag, `has no action named ${name}`)
      const payload = Schema.decodeUnknownExit(jsonCodec(action.payload))(values)
      if (Exit.isFailure(payload)) return ignored(tag, name, payload.cause)
      const run = handler(state, payload.value).pipe(
        Effect.provideContext(context),
        Effect.catchCause((cause) => Effect.sync(() => report(tag, `${name} failed`, cause)))
      )
      if (action.concurrency === "switch") runLatest(name, run)
      else runAll(run)
    }
    for (const [name, values] of waiting.splice(0)) dispatch(name, values)
  })

  Effect.runFork(start.pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.catchCause((cause) => Effect.sync(() => report(tag, "could not start", cause)))
  ))
}

/** A binding's value when the event happens: what was typed, or whether a box is checked. */
const read = (element: Element, kind: "value" | "checked"): unknown => {
  const field = element as Partial<HTMLInputElement>
  return kind === "checked" ? field.checked === true : String(field.value ?? "")
}

const resolve = (payload: Readonly<Record<string, unknown>>, element: Element): Record<string, unknown> => {
  const values: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    values[key] = On.isPlaceholder(value) ? read(element, On.placeholderKind(value)) : value
  }
  return values
}

const commandsFor = (event: Event, binding: unknown): ReadonlyArray<On.Command> => {
  if (Array.isArray(binding)) return binding as ReadonlyArray<On.Command>
  // Key bindings map KeyboardEvent.key to commands
  if (event instanceof KeyboardEvent && typeof binding === "object" && binding !== null) {
    return (binding as Readonly<Record<string, ReadonlyArray<On.Command>>>)[event.key] ?? []
  }
  return []
}

const listener = (event: Event): void => {
  const attribute = `data-on-${event.type}`
  const target = event.target as Node | null
  // The nearest element with a binding for the event, up to its component's element
  for (let node = target instanceof Element ? target : target?.parentElement ?? null; node !== null; node = node.parentElement) {
    if (node.hasAttribute(attribute)) {
      const host = node.closest(selector)
      const instance = host === null ? undefined : instances.get(host)
      if (instance === undefined) return
      let binding: unknown
      try {
        binding = JSON.parse(node.getAttribute(attribute) ?? "[]")
      } catch {
        return
      }
      const commands = commandsFor(event, binding)
      if (commands.length === 0) return
      if (event.type === "submit" || event instanceof KeyboardEvent) event.preventDefault()
      for (const command of commands) {
        if (command._tag === "Action") instance.run(command.action, resolve(command.payload, node))
      }
      return
    }
    if (node.matches(selector)) return
  }
}

/** Starts the runtime: components in the page now, and any added later, such as by htmx. */
export const start = (): void => {
  const shared: Shared = {
    memoMap: Effect.runSync(Layer.makeMemoMap),
    scope: Effect.runSync(Scope.make())
  }
  const mountWithin = (root: ParentNode): void => {
    if (root instanceof HTMLElement && root.matches(selector) && !instances.has(root)) mount(root, shared)
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (!instances.has(element)) mount(element, shared)
    }
  }
  const unmountDetached = (root: Element): void => {
    const hosts = [...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector))]
    for (const host of hosts) {
      if (host.isConnected) continue
      instances.get(host)?.close()
      instances.delete(host)
    }
  }
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) mountWithin(node)
      }
      // An element that moves is removed and added again: wait to see whether it stays
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof Element) queueMicrotask(() => unmountDetached(node))
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
  for (const type of events) document.addEventListener(type, listener)
  mountWithin(document)
}
