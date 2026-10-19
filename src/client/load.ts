/**
 * Placeholders that load, as View.Lazy renders them: an element with
 * data-load fetches its URL once it is in the page, once it scrolls into
 * view, or every so often, and the response goes into the element itself.
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"

import type * as Protocol from "../internal/Protocol.js"
import { reportFailure, send } from "./request.js"

/** Waits until the element scrolls into view. */
const visible = (element: Element): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      resume(Effect.void)
    })
    observer.observe(element)
    return Effect.sync(() => observer.disconnect())
  })

/**
 * Starts loading as the element's Load says, and returns how to stop: when
 * the element leaves the page, such as when its own response replaces it,
 * polling ends and a request in flight is aborted.
 */
export const start = (element: Element, load: Protocol.Load): (() => void) => {
  const request = { url: load.url, method: "GET" }
  // A failed load is logged, and polling goes on
  const once = send(request, element, { target: element, swap: load.swap }).pipe(Effect.catchCause(reportFailure(request)))
  const { when } = load
  let run: Effect.Effect<void>
  if (when === "load") run = once
  else if (when === "visible") run = Effect.andThen(visible(element), once)
  else if (typeof when.every === "number" && when.every > 0) run = Effect.forever(Effect.andThen(Effect.sleep(when.every), once))
  else throw new Error(`Expected "load", "visible" or { every } with a number of milliseconds, received ${JSON.stringify(when)}`)
  const fiber = Effect.runFork(run)
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}
