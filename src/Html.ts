import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"

/** Brand used to distinguish Html values from ordinary strings. */
export const TypeId: unique symbol = Symbol.for("effect-views/Html") as any

/** HTML markup; the brand does not guarantee that its contents were sanitized. */
export interface Html {
  readonly [TypeId]: typeof TypeId
  readonly value: string
}

export type Child = Html | string | number | bigint | boolean | null | undefined | ReadonlyArray<Child>

export interface Attributes {
  readonly children?: Child
  readonly [name: string]: unknown
}

const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
])

const urlAttributes = new Set([
  "action",
  "background",
  "data",
  "formaction",
  "href",
  "hx-delete",
  "hx-get",
  "hx-patch",
  "hx-post",
  "hx-push-url",
  "hx-put",
  "hx-replace-url",
  "poster",
  "src",
  "xlink:href"
])

const attributeAliases: Readonly<Record<string, string>> = {
  className: "class",
  htmlFor: "for"
}

const make = (value: string): Html => {
  const html: Html = { [TypeId]: TypeId, value }
  return Object.freeze(html)
}

/** Checks for the Html brand, without inspecting the markup. */
export const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && TypeId in value && value[TypeId] === TypeId

export const render = (self: Html): string => self.value

export const escapeText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

export const text = (value: string | number | bigint): Html => make(escapeText(String(value)))

/** Wraps raw markup without escaping or sanitizing it. Use only with trusted HTML. */
export const unsafe = (value: string): Html => make(value)

const renderChild = (child: Child): string => {
  if (isHtml(child)) return child.value
  if (Array.isArray(child)) return child.map(renderChild).join("")
  if (child === null || child === undefined || typeof child === "boolean") return ""
  if (typeof child === "string" || typeof child === "number" || typeof child === "bigint") {
    return escapeText(String(child))
  }
  throw new TypeError(`Unsupported HTML child: ${String(child)}`)
}

export const fragment = (...children: ReadonlyArray<Child>): Html => make(children.map(renderChild).join(""))

const isSafeUrl = (value: string): boolean => {
  const normalized = value.trim().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase()
  return !normalized.startsWith("javascript:") &&
    !normalized.startsWith("vbscript:") &&
    !normalized.startsWith("data:")
}

const renderStyle = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The style attribute must be a string or an object")
  }

  return Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined && item !== false)
    .map(([name, item]) => {
      const property = name.startsWith("--")
        ? name
        : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      return `${property}:${String(item)}`
    })
    .join(";")
}

const renderAttribute = (inputName: string, inputValue: unknown): string => {
  if (inputName === "children" || inputName === "key" || inputValue === null || inputValue === undefined || inputValue === false) {
    return ""
  }
  if (inputName === "dangerouslySetInnerHTML" || inputName.toLowerCase() === "srcdoc" || /^on/i.test(inputName)) {
    throw new TypeError(`Unsafe HTML attribute: ${inputName}`)
  }

  const name = attributeAliases[inputName] ?? inputName
  if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) {
    throw new TypeError(`Invalid HTML attribute name: ${name}`)
  }
  if (inputValue === true) return ` ${name}`
  if (typeof inputValue === "function" || typeof inputValue === "symbol" || typeof inputValue === "object" && name !== "style") {
    throw new TypeError(`Unsupported value for HTML attribute: ${name}`)
  }

  const value = name === "style" ? renderStyle(inputValue) : String(inputValue)
  if (urlAttributes.has(name.toLowerCase()) && !isSafeUrl(value)) {
    throw new TypeError(`Unsafe URL in HTML attribute: ${name}`)
  }
  return ` ${name}="${escapeText(value)}"`
}

export const element = (name: string, attributes: Attributes | null = null): Html => {
  if (!/^[A-Za-z][A-Za-z0-9:-]*$/.test(name)) {
    throw new TypeError(`Invalid HTML element name: ${name}`)
  }

  const props = attributes ?? {}
  const encodedAttributes = Object.entries(props).map(([key, value]) => renderAttribute(key, value)).join("")
  if (voidElements.has(name.toLowerCase())) return make(`<${name}${encodedAttributes}>`)
  return make(`<${name}${encodedAttributes}>${renderChild(props.children)}</${name}>`)
}

export const document = (content: Html): Html => make(`<!doctype html>${content.value}`)

const HtmlDeclaration = Schema.declare<Html>(isHtml, {
  identifier: "Html",
  description: "A branded HTML representation"
})

/**
 * Encodes Html as a text/html response. Decoding trusts the input string as raw
 * markup, just like unsafe; it does not escape or sanitize it.
 */
export const schema = Schema.String.pipe(
  Schema.decodeTo(
    HtmlDeclaration,
    SchemaTransformation.transform({
      decode: unsafe,
      encode: render
    })
  ),
  HttpApiSchema.asText({ contentType: "text/html; charset=utf-8" })
)
