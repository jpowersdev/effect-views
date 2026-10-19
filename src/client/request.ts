/**
 * Requests the runtime makes for HTML to put into the page, rather than
 * loading a page: submitting a form bound with a Request command, and loading
 * a placeholder. The server answers with a fragment, and the response headers
 * in Protocol say where it goes, how, and what to dispatch once it is there.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"

import * as Protocol from "../internal/Protocol.js"
import type * as On from "../On.js"
import { autofocus, snapshot, swap } from "./swap.js"

/** Sent with every request for HTML to put into the page, live components' actions included. */
export const headers: Readonly<Record<string, string>> = { [Protocol.requestHeader]: "true", accept: "text/html" }

export interface Outgoing {
  readonly url: string
  readonly method: string
  readonly body?: URLSearchParams | FormData
}

/** Where a response goes, unless its headers say otherwise. */
export interface Into {
  /** The element, or a selector for it, found when the response arrives, since the page can change while waiting. */
  readonly target: Element | string
  readonly swap: Protocol.Swap
}

const find = (target: Element | string): Element | null =>
  typeof target === "string" ? document.querySelector(target) : target

const swaps: ReadonlyArray<string> = ["outer", "inner", "append", "none"] satisfies ReadonlyArray<Protocol.Swap | "none">

const isSwap = (value: string): value is Protocol.Swap | "none" => swaps.includes(value)

/** The page's Config, read from its meta element when a response needs it. */
const config = (): Protocol.Config => {
  const content = document.querySelector(`meta[name="${Protocol.configMeta}"]`)?.getAttribute("content")
  if (content === null || content === undefined) return {}
  try {
    return JSON.parse(content) as Protocol.Config
  } catch (cause) {
    console.error(`effect-views: <meta name="${Protocol.configMeta}"> does not hold JSON`, cause)
    return {}
  }
}

/** A successful response, or a form returned with its errors, goes into its target. */
const put = (response: Response, html: string, into: Into, sent: ReadonlyMap<Element, string>): void => {
  const how = response.headers.get(Protocol.swapHeader) ?? into.swap
  if (!isSwap(how)) return console.error(`effect-views: ${Protocol.swapHeader} must be one of ${swaps.join(", ")}, not ${how}`)
  if (how === "none") return
  const selector = response.headers.get(Protocol.targetHeader)
  const target = selector === null ? find(into.target) : document.querySelector(selector)
  if (target === null) return console.error(`effect-views: nothing in the page matches ${selector ?? String(into.target)}`)
  autofocus(swap(target, html, how, sent))
}

/** An error response replaces what the page's error target contains, or is logged when there is none. */
const failed = (request: Outgoing, response: Response, html: string): void => {
  const selector = config().errorTarget
  const target = selector === undefined ? null : document.querySelector(selector)
  if (target === null) {
    const missing = selector === undefined ? "" : `, and nothing in the page matches the error target ${selector}`
    return console.error(`effect-views: ${request.method} ${request.url} failed with ${response.status} ${response.statusText}${missing}`)
  }
  autofocus(swap(target, html, "inner"))
}

/** Dispatches the response's events from the element that made the request, or the document once it is gone. */
const dispatch = (header: string | null, origin: Element): void => {
  if (header === null) return
  let events: unknown
  try {
    events = JSON.parse(header)
  } catch (cause) {
    return console.error(`effect-views: ${Protocol.eventHeader} does not hold JSON`, cause)
  }
  if (typeof events !== "object" || events === null || Array.isArray(events)) {
    return console.error(`effect-views: ${Protocol.eventHeader} must map event names to their details`)
  }
  const at: EventTarget = origin.isConnected ? origin : document
  for (const [name, detail] of Object.entries(events)) at.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }))
}

/**
 * Sends the request and puts the response into the page. `origin` is the
 * element that made it, which events bubble from. What the target's fields
 * show is read first, so what is typed while waiting survives the response.
 */
export const send = (request: Outgoing, origin: Element, into: Into): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const sent = snapshot(find(into.target))
    // Interrupting the fiber, such as when a placeholder leaves the page, aborts the request
    const response = yield* Effect.tryPromise((signal) =>
      fetch(request.url, { method: request.method, headers, body: request.body ?? null, signal })
    )
    const html = yield* Effect.tryPromise(() => response.text())
    const location = response.headers.get(Protocol.locationHeader)
    if (location !== null) return window.location.assign(location)
    // fetch followed a redirect, such as Html.seeOther's, which means another page rather than a fragment
    if (response.redirected) return window.location.assign(response.url)
    if (response.status === 422 || (response.ok && response.status !== 204)) put(response, html, into, sent)
    else if (response.status >= 400) failed(request, response, html)
    dispatch(response.headers.get(Protocol.eventHeader), origin)
  })

/** Logs a request that failed to complete, such as when the network is down. */
export const reportFailure = (request: Outgoing) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.sync(() => console.error(`effect-views: ${request.method} ${request.url} failed`, Cause.squash(cause)))

/**
 * What the browser would send for the form, and where: its fields with the
 * button that submitted it, to its action by its method, unless the button
 * says otherwise with formaction, formmethod or formenctype.
 */
const formRequest = (form: HTMLFormElement, submitter: HTMLElement | null): Outgoing => {
  const button = submitter as HTMLButtonElement | HTMLInputElement | null
  const action = button?.hasAttribute("formaction") ? button.formAction : form.action
  const method = (button?.hasAttribute("formmethod") ? button.formMethod : form.method).toUpperCase()
  const enctype = button?.hasAttribute("formenctype") ? button.formEnctype : form.enctype
  const data = new FormData(form, submitter)
  if (method !== "GET" && enctype === "multipart/form-data") return { url: action, method, body: data }
  const fields = new URLSearchParams()
  // Without multipart, a file is sent by its name, as the browser does
  for (const [name, value] of Array.from(data.entries())) fields.append(name, typeof value === "string" ? value : value.name)
  if (method !== "GET") return { url: action, method, body: fields }
  // The fields replace the action's query, as they do when the browser submits the form
  const url = new URL(action)
  url.search = fields.toString()
  return { url: url.href, method }
}

/** Forms waiting for a response, which ignore further submits, so a double click posts once. */
const waiting = new WeakSet<HTMLFormElement>()

/**
 * Submits the form a Request is bound to with the runtime. It is the page's,
 * not a live component's, so it needs no component around it; and it is not
 * the form's either, so the response still goes into the page when the form
 * is gone by then.
 */
export const submit = (command: On.Request, form: Element, event: Event): void => {
  if (!(form instanceof HTMLFormElement)) {
    return console.error(`effect-views: a Request submits a form, but is bound to <${form.localName}>`)
  }
  if (waiting.has(form)) return
  const request = formRequest(form, event instanceof SubmitEvent ? event.submitter : null)
  waiting.add(form)
  Effect.runFork(send(request, form, command).pipe(
    Effect.catchCause(reportFailure(request)),
    Effect.ensuring(Effect.sync(() => waiting.delete(form)))
  ))
}
