/**
 * Updates an element's contents to match new markup, changing only what
 * differs, so focus, the caret, scroll positions and elements other code holds
 * survive. Elements are matched by `data-key` (JSX `key`), then by position
 * and tag. Components inside are left to render themselves.
 */

const keyOf = (node: Node): string | null =>
  node.nodeType === Node.ELEMENT_NODE ? (node as Element).getAttribute("data-key") : null

const isComponent = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute("data-live")

/** What each form field showed when it was last rendered, to tell a change of state from what was typed since. */
const rendered = new WeakMap<Element, string>()

/** During morphElement for a server's response: what each field showed when the request was sent. */
let sent: ReadonlyMap<Element, string> | undefined

/**
 * Shows `next`, the field's value as rendered, or keeps what it shows now.
 *
 * - A server's response decides, unless the field changed after the request
 *   was sent: what was typed in the meantime is newer.
 * - Otherwise, as when the browser renders a component again, a field changes
 *   only when its rendered value did: when the state still says what it said,
 *   what was typed is newer, so a render that arrives while typing keeps it.
 */
const syncField = (element: Element, last: string, next: string, current: string, apply: (value: string) => void): void => {
  const previous = rendered.get(element) ?? last
  rendered.set(element, next)
  const whenSent = sent?.get(element)
  if (whenSent !== undefined) {
    if (current === whenSent && current !== next) apply(next)
    return
  }
  if (previous !== next) apply(next)
}

/** What a form field shows, as one string, to compare with how it was rendered. */
export const fieldValue = (field: Element): string => {
  if (field instanceof HTMLInputElement) {
    return field.type === "checkbox" || field.type === "radio" ? String(field.checked) : field.value
  }
  if (field instanceof HTMLTextAreaElement) return field.value
  if (field instanceof HTMLSelectElement) return selectedValues(field.options, (option) => option.selected)
  return ""
}

const selectedValues = (options: Iterable<HTMLOptionElement>, selected: (option: HTMLOptionElement) => boolean) =>
  Array.from(options).filter(selected).map((option) => option.value).join("\n")

/** Form fields keep what is shown in properties, which attributes only set until the field is used. */
const syncFormState = (from: Element, to: Element): void => {
  if (from instanceof HTMLInputElement) {
    if (from.type === "checkbox" || from.type === "radio") {
      syncField(from, String(from.hasAttribute("checked")), String(to.hasAttribute("checked")), fieldValue(from), (value) => {
        from.checked = value === "true"
      })
    } else if (from.type !== "file") {
      syncField(from, from.getAttribute("value") ?? "", to.getAttribute("value") ?? "", from.value, (value) => {
        if (from.value !== value) from.value = value
      })
    }
  } else if (from instanceof HTMLTextAreaElement) {
    syncField(from, from.defaultValue, to.textContent ?? "", from.value, (value) => {
      if (from.value !== value) from.value = value
    })
  }
}

const syncSelect = (from: HTMLSelectElement, to: HTMLSelectElement, last: string, current: string): void => {
  const next = selectedValues(to.options, (option) => option.hasAttribute("selected"))
  syncField(from, last, next, current, (value) => {
    const values = new Set(value.split("\n"))
    for (const option of Array.from(from.options)) option.selected = values.has(option.value)
  })
}

/** Attributes the browser or other code changes, such as `open` on <details>, can be kept with `data-keep="open"`. */
const syncAttributes = (from: Element, to: Element): void => {
  const keep = new Set((to.getAttribute("data-keep") ?? "").split(/\s+/).filter((name) => name !== ""))
  for (const { name, value } of Array.from(to.attributes)) {
    if (!keep.has(name) && from.getAttribute(name) !== value) from.setAttribute(name, value)
  }
  for (const { name } of Array.from(from.attributes)) {
    if (!keep.has(name) && !to.hasAttribute(name)) from.removeAttribute(name)
  }
}

const move = (parent: ParentNode, node: ChildNode, before: ChildNode | null): void => {
  // moveBefore keeps the moved element's state, such as focus or a playing video, where browsers support it
  const moveBefore = (parent as { moveBefore?: (node: Node, before: Node | null) => void }).moveBefore
  if (moveBefore !== undefined) {
    try {
      moveBefore.call(parent, node, before)
      return
    } catch {
      // Falls back below, such as when one of them is not connected
    }
  }
  parent.insertBefore(node, before)
}

const morphNode = (from: ChildNode, to: ChildNode): void => {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName || keyOf(from) !== keyOf(to)) {
    from.replaceWith(to)
    return
  }
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue
    return
  }
  const element = from as Element
  const next = to as Element
  if (isComponent(element)) return
  syncFormState(element, next)
  syncAttributes(element, next)
  if (element instanceof HTMLSelectElement) {
    const last = selectedValues(element.options, (option) => option.defaultSelected)
    const current = fieldValue(element)
    morphChildNodes(element, next)
    syncSelect(element, next as HTMLSelectElement, last, current)
  } else if (!(element instanceof HTMLTextAreaElement)) {
    morphChildNodes(element, next)
  }
}

const morphChildNodes = (parent: ParentNode, next: ParentNode): void => {
  const keyed = new Map<string, ChildNode>()
  for (const child of Array.from(parent.childNodes)) {
    const key = keyOf(child)
    if (key !== null) keyed.set(key, child)
  }
  // Nodes before the cursor are done; the ones from it on have not been matched yet
  let cursor: ChildNode | null = parent.firstChild
  for (const incoming of Array.from(next.childNodes)) {
    const key = keyOf(incoming)
    let match: ChildNode | undefined
    if (key !== null) {
      match = keyed.get(key)
      keyed.delete(key)
    } else if (cursor !== null && keyOf(cursor) === null && cursor.nodeName === incoming.nodeName) {
      match = cursor
    }
    if (match === undefined) {
      parent.insertBefore(incoming, cursor)
      continue
    }
    if (match === cursor) cursor = cursor.nextSibling
    else move(parent, match, cursor)
    morphNode(match, incoming)
  }
  while (cursor !== null) {
    const after: ChildNode | null = cursor.nextSibling
    cursor.remove()
    cursor = after
  }
}

const parse = (html: string): DocumentFragment => {
  const template = document.createElement("template")
  template.innerHTML = html
  return template.content
}

/** Makes the element's contents match the markup. */
export const morphChildren = (target: Element, html: string): void => {
  morphChildNodes(target, parse(html))
}

/**
 * Makes the element match markup for the element itself, such as a component
 * rendered again by the server: its attributes and its contents. `whenSent`
 * holds what its fields showed when the request was sent; see syncField.
 */
export const morphElement = (target: Element, html: string, whenSent?: ReadonlyMap<Element, string>): void => {
  const next = parse(html).firstElementChild
  if (next === null) throw new Error(`Expected an element, received: ${html.slice(0, 80)}`)
  if (next.localName !== target.localName) {
    target.replaceWith(next)
    return
  }
  // The server renders the component without the key its parent gave it
  const key = target.getAttribute("data-key")
  if (key !== null && !next.hasAttribute("data-key")) next.setAttribute("data-key", key)
  sent = whenSent
  try {
    syncAttributes(target, next)
    morphChildNodes(target, next)
  } finally {
    sent = undefined
  }
}
