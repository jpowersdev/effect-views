/**
 * Puts HTML from the server into the page, as a Swap says: replacing an
 * element or what it contains by morphing, so focus and what is being typed
 * survive, or adding to what it contains. The server renders the page, so
 * live components inside show what it rendered, and browser ones start again
 * with the state it gave them, as loading the page would.
 */
import type * as Protocol from "../internal/Protocol.js"
import { fieldValue, morphChildren, morphElement } from "./morph.js"

const fields = "input, select, textarea"

/** What each field in the element shows now, so a response can tell what was typed after its request was sent. */
export const snapshot = (target: Element | null): ReadonlyMap<Element, string> => {
  const values = new Map<Element, string>()
  if (target === null) return values
  if (target.matches(fields)) values.set(target, fieldValue(target))
  for (const field of Array.from(target.querySelectorAll(fields))) values.set(field, fieldValue(field))
  return values
}

/**
 * Puts the HTML into the target as `swap` says, and returns the elements it
 * put there. `whenSent` is the target's snapshot from when the request was
 * sent, if a request asked for the HTML.
 */
export const swap = (
  target: Element,
  html: string,
  swap: Protocol.Swap,
  whenSent?: ReadonlyMap<Element, string>
): ReadonlyArray<Element> => {
  switch (swap) {
    case "outer": {
      // Nothing to put in its place removes it, such as a deleted row
      if (html.trim() === "") {
        target.remove()
        return []
      }
      return [morphElement(target, html, whenSent, "render")]
    }
    case "inner": {
      morphChildren(target, html, whenSent, "render")
      return Array.from(target.children)
    }
    case "append": {
      const template = document.createElement("template")
      template.innerHTML = html
      const added = Array.from(template.content.children)
      target.append(template.content)
      return added
    }
  }
}

/**
 * Focuses the first element with `autofocus` among those swapped in, as the
 * browser does for a page it loads: Form renders it on the first invalid
 * field, or the error summary.
 */
export const autofocus = (elements: ReadonlyArray<Element>): void => {
  for (const element of elements) {
    const found = element.matches("[autofocus]") ? element : element.querySelector("[autofocus]")
    if (found instanceof HTMLElement || found instanceof SVGElement) {
      found.focus()
      return
    }
  }
}
