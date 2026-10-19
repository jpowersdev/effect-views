/**
 * The effect-views runtime. Assets.layer bundles it, with the modules of the
 * components that run in the browser, and the page head loads it. It finds
 * each live component's element and runs its actions when the events bound
 * with On happen: on the server, by posting to the action's endpoint and
 * updating the component with the HTML returned; in the browser, by loading
 * the component's module, running the action's handler, and rendering the
 * component again when its state changes. It also does what the page asks
 * for beyond components: forms bound with a Request, placeholders that load,
 * and subscriptions to server-sent events; see Protocol.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberMap from "effect/FiberMap"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"

import * as Html from "../Html.js"
import * as Protocol from "../internal/Protocol.js"
import * as LiveComponent from "../LiveComponent.js"
import * as On from "../On.js"
import * as Load from "./load.js"
import { fieldValue, morphChildren, morphElement } from "./morph.js"
import { headers, submit } from "./request.js"
import * as Subscription from "./subscription.js"

const selector = "[data-live]"

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

/** What each of the component's fields shows now, to tell what was typed while a request was in flight. */
const fieldValues = (host: Element): Map<Element, string> => {
  const values = new Map<Element, string>()
  for (const field of Array.from(host.querySelectorAll("input, select, textarea"))) {
    if (field.closest(selector) !== host) continue
    values.set(field, fieldValue(field))
  }
  return values
}

const post = (host: Element, command: On.ServerAction): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const sent = fieldValues(host)
    const body = formValues(host)
    for (const [name, value] of Object.entries(command.payload)) {
      body.delete(name)
      for (const item of typeof value === "string" ? [value] : value) body.append(name, item)
    }
    // Interrupting the fiber, such as for a newer run of a "switch" action, aborts the request
    const response = yield* Effect.tryPromise((signal) =>
      fetch(command.url, { method: "POST", body, headers, signal })
    )
    const html = yield* Effect.tryPromise(() => response.text())
    if (!response.ok) return yield* Effect.fail(new Error(`${response.status} ${response.statusText}: ${html}`))
    // The response decides what the fields show, except where the person typed after the request was sent
    morphElement(host, html, sent)
  })

const mountServer = (element: HTMLElement): void => {
  const tag = element.localName
  const scope = Effect.runSync(Scope.make())
  const runner = runnerIn(scope)
  // One request at a time, in order: each sends the state the last one returned, so none is lost or undone
  const turn = Semaphore.makeUnsafe(1)
  instances.set(element, {
    run: (command) => {
      if (command._tag !== "Server") return report(tag, `runs on the server, but received ${command._tag}`)
      const run = Effect.gen(function* () {
        // Waiting for events to stop does not hold up the component's other actions
        if (command.debounce !== undefined) yield* Effect.sleep(command.debounce)
        yield* turn.withPermits(1)(post(element, command))
      }).pipe(
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
  let closed = false
  instances.set(element, {
    run: (command, bound) => {
      if (command._tag !== "Action") return report(tag, `runs in the browser, but received ${command._tag}`)
      // Values are read when the event happens, even when the module is still loading
      const values = resolve(command.payload, bound)
      if (dispatch === undefined) waiting.push([command.action, values])
      else dispatch(command.action, values)
    },
    // Interrupts the component's actions and stops rendering it
    close: () => {
      closed = true
      closeScope(scope)()
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
            // A render waiting for the frame when the component stopped, such as to start again, is dropped
            if (closed || latest === shown) return
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

/** A link or submit button would also navigate or submit; a bound form, key, or drop target would do its usual thing. */
const cancels = (event: Event, element: Element): boolean => {
  switch (event.type) {
    case "submit":
    case "keydown":
    case "keyup":
    case "dragover":
    case "drop":
      return true
    case "click":
      return (element instanceof HTMLAnchorElement && element.hasAttribute("href")) ||
        (element instanceof HTMLButtonElement && element.type === "submit") ||
        (element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image"))
    default:
      return false
  }
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
      let binding: unknown
      try {
        binding = JSON.parse(node.getAttribute(attribute) ?? "[]")
      } catch {
        return
      }
      const commands = commandsFor(event, binding)
      // A key binding without this key leaves it to bindings further out
      if (commands.length === 0) {
        if (node.matches(selector)) return
        continue
      }
      // Requests are the page's, so they run outside components too; actions need the component they belong to
      const runs = instance === undefined ? commands.filter((command) => command._tag === "Request") : commands
      if (runs.length === 0) return
      if (cancels(event, node)) event.preventDefault()
      for (const command of runs) {
        if (command._tag === "Request") submit(command, node, event)
        else instance?.run(command, node)
      }
      return
    }
    if (node.matches(selector)) return
  }
}

// Starting and stopping ----------------------------------------------------------

/** Starts what an attribute asks for on an element, given the attribute's value, and returns how to stop it. */
type Starter = (element: HTMLElement, value: string) => () => void

/** What runs on each element, by the attribute that asked for it, with the value it started with. */
const running = new WeakMap<Element, Map<string, { readonly value: string; readonly stop: () => void }>>()

/** Starts what an attribute holding JSON asks for, such as a Load. */
const fromJson = <A>(start: (element: HTMLElement, value: A) => () => void): Starter => (element, value) =>
  start(element, JSON.parse(value) as A)

/**
 * Starts the runtime: what the page asks for now, and in elements added
 * later, such as by a swap or a live component rendering again. Each stops
 * when its element leaves the page.
 */
export const start = (): void => {
  const shared: Shared = {
    memoMap: Effect.runSync(Layer.makeMemoMap),
    scope: Effect.runSync(Scope.make())
  }
  const starters = new Map<string, Starter>([
    ["data-live", (element, runs) => {
      if (runs === "browser") mountBrowser(element, shared)
      else mountServer(element)
      return () => {
        instances.get(element)?.close()
        instances.delete(element)
      }
    }],
    [Protocol.loadAttribute, fromJson(Load.start)],
    [Protocol.subscribeAttribute, fromJson(Subscription.start)]
  ])
  const startable = Array.from(starters.keys(), (attribute) => `[${attribute}]`).join(", ")

  /** Starts what the attribute asks for, unless it already runs; stops what ran with a value it no longer has. */
  const update = (element: HTMLElement, attribute: string, starter: Starter): void => {
    const value = element.getAttribute(attribute)
    const started = running.get(element)
    const current = started?.get(attribute)
    if (current?.value === value) return
    current?.stop()
    started?.delete(attribute)
    if (value === null) return
    let stop = () => {}
    try {
      stop = starter(element, value)
    } catch (cause) {
      report(element.localName, `could not start its ${attribute}`, cause)
    }
    if (started === undefined) running.set(element, new Map([[attribute, { value, stop }]]))
    else started.set(attribute, { value, stop })
  }
  const mount = (element: HTMLElement): void => {
    for (const [attribute, starter] of starters) if (element.hasAttribute(attribute)) update(element, attribute, starter)
  }
  const within = (root: ParentNode): ReadonlyArray<Element> => [
    ...(root instanceof Element && root.matches(startable) ? [root] : []),
    ...Array.from(root.querySelectorAll(startable))
  ]
  const mountWithin = (root: ParentNode): void => {
    for (const element of within(root)) if (element instanceof HTMLElement) mount(element)
  }
  const unmountDetached = (root: Element): void => {
    for (const element of within(root)) {
      if (element.isConnected) continue
      for (const { stop } of running.get(element)?.values() ?? []) stop()
      running.delete(element)
    }
  }
  /** Stops what the attribute started and starts it again, from what the element holds now. */
  const restart = (element: HTMLElement, attribute: string, starter: Starter): void => {
    running.get(element)?.get(attribute)?.stop()
    running.get(element)?.delete(attribute)
    update(element, attribute, starter)
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const element = record.target
        if (!(element instanceof HTMLElement) || !element.isConnected) continue
        const attribute = record.attributeName ?? ""
        // The server rendered a browser component again, for the page: it starts again with that state
        if (attribute === "data-live-state") {
          if (element.getAttribute("data-live") === "browser") restart(element, "data-live", starters.get("data-live")!)
          continue
        }
        // A swap that keeps the element but changes what it loads or subscribes to, such as the next page's placeholder
        const starter = starters.get(attribute)
        if (starter !== undefined) update(element, attribute, starter)
        continue
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) mountWithin(node)
      }
      // An element that moves is removed and added again: wait to see whether it stays
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof Element) queueMicrotask(() => unmountDetached(node))
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributeFilter: [Protocol.loadAttribute, Protocol.subscribeAttribute, "data-live-state"]
  })
  for (const type of On.events) document.addEventListener(type, listener)
  mountWithin(document)
}
