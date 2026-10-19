/**
 * Subscriptions, as View.Subscribe and View.Connect render them: an element
 * with data-subscribe opens a stream of server-sent events, and each event's
 * HTML goes into the element itself, or into the elements inside it that take
 * that event. The browser reconnects a stream that drops.
 */
import * as Protocol from "../internal/Protocol.js"
import { swap } from "./swap.js"

const subscriptions = `[${Protocol.subscribeAttribute}]`
const takers = `[${Protocol.eventAttribute}]`

/** The elements inside a View.Connect that take an event, leaving out those of another one inside it. */
const takersOf = (root: Element): ReadonlyArray<Element> =>
  Array.from(root.querySelectorAll(takers)).filter((element) => element.closest(subscriptions) === root)

/** Opens the element's Subscription, and returns how to close it, for when the element leaves the page. */
export const start = (element: Element, subscription: Protocol.Subscription): (() => void) => {
  const source = new EventSource(subscription.url)
  const on = (name: string, put: (html: string) => void): void => {
    source.addEventListener(name, (event) => put(String(event.data)))
  }
  source.addEventListener("error", () => {
    // The browser gives up on a stream the server refuses, such as with an error status
    if (source.readyState === EventSource.CLOSED) console.error(`effect-views: the stream at ${subscription.url} closed`)
  })

  if (subscription.events !== undefined) {
    for (const name of subscription.events) on(name, (html) => swap(element, html, subscription.swap))
    return () => source.close()
  }

  // Elements are found when their event arrives, since an earlier swap can have replaced them
  const names = new Set<string>()
  const listen = (): void => {
    for (const taker of takersOf(element)) {
      const name = taker.getAttribute(Protocol.eventAttribute) ?? ""
      if (names.has(name)) continue
      names.add(name)
      on(name, (html) => {
        for (const target of takersOf(element)) {
          if (target.getAttribute(Protocol.eventAttribute) === name) swap(target, html, subscription.swap)
        }
      })
    }
  }
  listen()
  // Elements added later can take events nothing has listened for yet
  const observer = new MutationObserver(listen)
  observer.observe(element, { childList: true, subtree: true, attributeFilter: [Protocol.eventAttribute] })
  return () => {
    source.close()
    observer.disconnect()
  }
}
