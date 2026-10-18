/**
 * The effect-views runtime for live components. Assets.layer bundles it, with
 * the modules of the components that run in the browser, and the page head
 * loads it. It finds each component's element and runs its actions when the
 * events bound with On happen: on the server, by posting to the action's
 * endpoint and updating the component with the HTML returned; in the browser,
 * by loading the component's module, running the action's handler, and
 * rendering the component again when its state changes.
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
import { morphChildren, morphElement } from "./morph.js"

const selector = "[data-live]"

/** The events On binds; each is handled once, on the document. */
const events = ["click", "input", "change", "submit", "keydown", "keyup", "focusin", "focusout"] as const

interface Instance {
  /** Runs a command from a binding on `element`, inside the component. */
  readonly run: (command: On.Command, element: Element) => void
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

/** Runs an action's effects: "switch" ones replace their own earlier run; the others run side by side. */
interface Runner {
  readonly latest: (key: string, effect: Effect.Effect<void>) => void
  readonly all: (effect: Effect.Effect<void>) => void
}

const runnerIn = (scope: Scope.Scope): Runner => {
  const latest = Effect.runSync(FiberMap.makeRuntime<never, string>().pipe(Effect.provideService(Scope.Scope, scope)))
  const all = Effect.runSync(FiberSet.makeRuntime<never>().pipe(Effect.provideService(Scope.Scope, scope)))
  return { latest: (key, effect) => void latest(key, effect), all: (effect) => void all(effect) }
}

const closeScope = (scope: Scope.Closeable) => () => {
  Effect.runFork(Scope.close(scope, Exit.void))
}

// On the server ------------------------------------------------------------------

/** The component's inputs, as a form would submit them, leaving out those of components inside it. */
const formValues = (host: Element): URLSearchParams => {
  const values = new URLSearchParams()
  const fields = host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    "input[name], select[name], textarea[name]"
  )
  for (const field of Array.from(fields)) {
    if (field.disabled || field.closest(selector) !== host) continue
    if (field instanceof HTMLSelectElement) {
      for (const option of Array.from(field.selectedOptions)) values.append(field.name, option.value)
      continue
    }
    if (field instanceof HTMLInputElement) {
      if ((field.type === "checkbox" || field.type === "radio") && !field.checked) continue
      if (["file", "submit", "button", "reset", "image"].includes(field.type)) continue
    }
    values.append(field.name, field.value)
  }
  return values
}

const post = (host: Element, command: On.ServerAction): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (command.debounce !== undefined) yield* Effect.sleep(command.debounce)
    const body = formValues(host)
    for (const [name, value] of Object.entries(command.payload)) {
      body.delete(name)
      for (const item of typeof value === "string" ? [value] : value) body.append(name, item)
    }
    // Interrupting the fiber, such as for a newer run of a "switch" action, aborts the request
    const response = yield* Effect.tryPromise((signal) =>
      fetch(command.url, { method: "POST", body, headers: { accept: "text/html" }, signal })
    )
    const html = yield* Effect.tryPromise(() => response.text())
    if (!response.ok) return yield* Effect.fail(new Error(`${response.status} ${response.statusText}: ${html}`))
    morphElement(host, html)
  })

const mountServer = (element: HTMLElement): void => {
  const tag = element.localName
  const scope = Effect.runSync(Scope.make())
  const runner = runnerIn(scope)
  instances.set(element, {
    run: (command) => {
      if (command._tag !== "Server") return report(tag, `runs on the server, but received ${command._tag}`)
      const run = post(element, command).pipe(
        Effect.catchCause((cause) => Effect.sync(() => report(tag, `${command.action} failed`, cause)))
      )
      if (command.concurrency === "switch") runner.latest(command.action, run)
      else runner.all(run)
    },
    close: closeScope(scope)
  })
}

// In the browser -----------------------------------------------------------------

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

const mountBrowser = (element: HTMLElement, shared: Shared): void => {
  const tag = element.localName
  const waiting: Array<readonly [string, Record<string, unknown>]> = []
  let dispatch: ((action: string, values: Record<string, unknown>) => void) | undefined
  const scope = Effect.runSync(Scope.make())
  instances.set(element, {
    run: (command, bound) => {
      if (command._tag !== "Action") return report(tag, `runs in the browser, but received ${command._tag}`)
      // Values are read when the event happens, even when the module is still loading
      const values = resolve(command.payload, bound)
      if (dispatch === undefined) waiting.push([command.action, values])
      else dispatch(command.action, values)
    },
    // Interrupts the component's actions and stops rendering it
    close: closeScope(scope)
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
    const runner = runnerIn(scope)

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
      const run = Effect.gen(function* () {
        if (action.debounce !== undefined) yield* Effect.sleep(action.debounce)
        yield* handler(state, payload.value)
      }).pipe(
        Effect.provideContext(context),
        Effect.catchCause((cause) => Effect.sync(() => report(tag, `${name} failed`, cause)))
      )
      if (action.concurrency === "switch") runner.latest(name, run)
      else runner.all(run)
    }
    for (const [name, values] of waiting.splice(0)) dispatch(name, values)
  })

  Effect.runFork(start.pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.catchCause((cause) => Effect.sync(() => report(tag, "could not start", cause)))
  ))
}

// Events -------------------------------------------------------------------------

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
      for (const command of commands) instance.run(command, node)
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
  const mount = (element: HTMLElement): void => {
    if (instances.has(element)) return
    if (element.getAttribute("data-live") === "browser") mountBrowser(element, shared)
    else mountServer(element)
  }
  const mountWithin = (root: ParentNode): void => {
    if (root instanceof HTMLElement && root.matches(selector)) mount(root)
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) mount(element)
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
