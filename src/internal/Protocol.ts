/**
 * What the server and the effect-views runtime say to each other, beyond live
 * components: the headers on requests the runtime makes and on the responses
 * to them, and the attributes it reads from the page. Shared by both sides,
 * so neither spells a name the other doesn't.
 */

/** On requests the runtime makes for HTML to put in the page: "true". The server answers with just the fragment. */
export const requestHeader = "effect-views-request"

/** Sends the browser to this URL, loading it as a page, instead of putting the response in the page. */
export const locationHeader = "effect-views-location"

/** Puts the response into the element this selector finds, instead of the one the request named. */
export const targetHeader = "effect-views-target"

/** Puts the response in the page this way instead, or not at all with "none"; see Swap. */
export const swapHeader = "effect-views-swap"

/**
 * Events to dispatch once the response is handled, as JSON: each name to its
 * detail, for any response that does not load another page. They bubble from
 * the element that made the request, or the document when it is gone. Only
 * ASCII, as headers hold, with other characters escaped as `\uXXXX`.
 */
export const eventHeader = "effect-views-event"

/**
 * How a response goes into its target: "outer" replaces the target with the
 * response's root element, or removes it when the response is empty, "inner"
 * replaces what the target contains, and "append" adds the response after
 * what it contains. Replacing updates the page in place, element by element,
 * keeping focus and what is being typed.
 */
export type Swap = "outer" | "inner" | "append"

/** The meta element, `<meta name="effect-views" content="…">`, whose content is the page's Config as JSON. */
export const configMeta = "effect-views"

export interface Config {
  /**
   * Where error responses go, as a selector whose contents they replace, such
   * as the fragments ErrorPage.layer renders. Without it, they are logged and
   * the page is left as it is. A 422, a form returned with its errors, is not
   * an error: it goes into the request's target.
   */
  readonly errorTarget?: string
}

/**
 * On an element: loads a URL with the runtime and puts the response in the
 * page, as View.Lazy renders it. Its value is a Load, as JSON.
 */
export const loadAttribute = "data-load"

export interface Load {
  readonly url: string
  /** "load" once the element is in the page, "visible" once it scrolls into view, or every so many milliseconds. */
  readonly when: "load" | "visible" | { readonly every: number }
  readonly swap: "outer" | "inner"
}

/**
 * On an element: opens a stream of server-sent events, as View.Subscribe and
 * View.Connect render it. Its value is a Subscription, as JSON.
 */
export const subscribeAttribute = "data-subscribe"

export interface Subscription {
  readonly url: string
  /**
   * The events whose HTML goes into the element itself. Without them, each
   * element inside with `data-event="name"` takes that event's HTML, as
   * View.Connect renders them.
   */
  readonly events?: ReadonlyArray<string>
  /** How each event's HTML goes into the element that takes it. */
  readonly swap: "inner" | "append"
}

/** On an element inside a View.Connect: the event, by name, whose HTML replaces what it contains. */
export const eventAttribute = "data-event"
