/**
 * Compiles JSX to calls of the automatic runtime, `jsx(type, props, key)`,
 * imported from the module a `@jsxImportSource` pragma names, effect-views
 * by default. Everything outside JSX stays as it was, and each element keeps
 * its line breaks, so TypeScript's types can be stripped afterwards and
 * positions after an element still match the source.
 *
 * @internal
 */
import * as Tokenizer from "./Tokenizer.js"

/** The runtime's module for a `@jsxImportSource`; a path, rather than a package, needs the file's extension. */
const runtimeOf = (importSource: string): string =>
  importSource.startsWith(".") || importSource.startsWith("/")
    ? `${importSource}/jsx-runtime.js`
    : `${importSource}/jsx-runtime`

const entities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: "\u00a0",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  times: "\u00d7",
  middot: "\u00b7",
  bull: "\u2022",
  laquo: "\u00ab",
  raquo: "\u00bb",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193"
}

const entity = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g

const identifier = /^[A-Za-z_$][\w$]*$/

/** Whitespace that JSX text trims at the ends of its lines, as esbuild counts it. */
const isWhitespace = (c: number): boolean =>
  c === 9 || c === 11 || c === 12 || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff

/** Compiles a module's JSX; throws a TokenizerError, with its position, at a mistake. */
export const transform = (source: string): string => {
  const scan = Tokenizer.scan(source, { jsx: true })
  const { tokens } = scan
  const n = tokens.count
  const kinds = tokens.kinds
  if (!kinds.includes(Tokenizer.JsxTagStart)) return source

  const kindOf = (i: number): number => kinds[i] ?? 0
  const startOf = (i: number): number => tokens.starts[i] ?? source.length
  const endOf = (i: number): number => tokens.ends[i] ?? source.length
  const text = (i: number): string => source.slice(startOf(i), endOf(i))
  const is = (i: number, value: string): boolean => Tokenizer.is(source, tokens, i, value)

  const fail = (message: string, index: number): never => {
    const { column, line } = Tokenizer.position(source, index)
    throw new Tokenizer.TokenizerError({ message, index, line, column })
  }

  let importSource = "effect-views"
  for (const comment of scan.comments) {
    const body = source.slice(comment.start, comment.end)
    if (/@jsxRuntime\s+classic\b/.test(body)) {
      fail("Only the automatic JSX runtime is supported, not @jsxRuntime classic", comment.start)
    }
    const pragma = /@jsxImportSource\s+([^\s*]+)/.exec(body)
    if (pragma !== null) {
      importSource = pragma[1]!
      break
    }
  }

  /** A name for the runtime's function that the module doesn't use already. */
  const unique = (base: string): string => {
    let name = base
    for (let suffix = 2; source.includes(name); suffix++) name = `${base}${suffix}`
    return name
  }
  const names = { jsx: unique("_jsx"), jsxs: unique("_jsxs"), Fragment: unique("_Fragment") }
  const used = new Set<keyof typeof names>()

  // Each JSX expression's closing brace
  const closing = new Int32Array(n).fill(-1)
  {
    const open: Array<number> = []
    for (let i = 0; i < n; i++) {
      if (kindOf(i) === Tokenizer.JsxExpressionStart) open.push(i)
      else if (kindOf(i) === Tokenizer.JsxExpressionEnd) closing[open.pop() ?? i] = i
    }
  }

  const decodeEntities = (raw: string, offset: number): string =>
    raw.includes("&")
      ? raw.replace(entity, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined, at: number) => {
        if (decimal !== undefined) return String.fromCodePoint(parseInt(decimal, 10))
        if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16))
        const value = entities[name!]
        if (value === undefined) return fail(`Unknown HTML entity ${match}`, offset + at)
        return value
      })
      : raw

  /**
   * JSX text as React reads it, the way esbuild does: the first line keeps
   * its leading whitespace and the last its trailing whitespace, other lines
   * are trimmed, empty lines dropped, and the rest joined by a space.
   */
  const textOf = (start: number, end: number): string => {
    let decoded = ""
    // The first line keeps its leading whitespace
    let first = start
    let afterLast = -1
    for (let i = start; i < end; i++) {
      const c = source.charCodeAt(i)
      if (Tokenizer.isLineTerminator(c)) {
        if (first !== -1 && afterLast !== -1) {
          if (decoded !== "") decoded += " "
          decoded += decodeEntities(source.slice(first, afterLast), first)
        }
        first = -1
      } else if (!isWhitespace(c)) {
        afterLast = i + 1
        if (first === -1) first = i
      }
    }
    if (first !== -1) {
      // The last line keeps its trailing whitespace
      if (decoded !== "") decoded += " "
      decoded += decodeEntities(source.slice(first, end), first)
    }
    return decoded
  }

  /** JavaScript between two tokens, as in the source but with its JSX compiled. */
  const javascript = (from: number, to: number, start: number, end: number): string => {
    let out = ""
    let at = start
    for (let i = from; i < to;) {
      if (kindOf(i) !== Tokenizer.JsxTagStart) {
        i++
        continue
      }
      const element = compile(i)
      out += source.slice(at, startOf(i)) + element.code
      at = element.end
      i = element.next
    }
    return out + source.slice(at, end)
  }

  /** An expression's JavaScript, from its `{`, as in `{count + 1}`; undefined when it holds only comments. */
  const expressionOf = (open: number): { readonly code: string | undefined; readonly next: number } => {
    const close = closing[open] ?? -1
    if (close === -1) return fail("Unterminated JSX expression", startOf(open))
    const code = close === open + 1 ? undefined : javascript(open + 1, close, endOf(open), startOf(close))
    return { code, next: close + 1 }
  }

  const property = (name: string): string => identifier.test(name) ? name : JSON.stringify(name)

  /** A tag's name, from its first token: `div`, `A.B` or `svg:rect`. */
  const tagName = (from: number): { readonly name: string; readonly next: number; readonly expression: boolean } => {
    let name = text(from)
    let i = from + 1
    let member = false
    let namespaced = false
    while ((is(i, ".") || is(i, ":")) && kindOf(i + 1) === Tokenizer.JsxName) {
      if (is(i, ".")) member = true
      else namespaced = true
      name += text(i) + text(i + 1)
      i += 2
    }
    const expression = member || (!namespaced && !/^[a-z]/.test(name) && !name.includes("-"))
    return { name, next: i, expression }
  }

  /** An element or fragment, from its `<`, as a call; it has the element's line breaks. */
  const compile = (open: number): { readonly code: string; readonly next: number; readonly end: number } => {
    const elementStart = startOf(open)
    let last = elementStart
    /** Line breaks from where the code has reached in the source to a position. */
    const breaks = (position: number): string => {
      if (position <= last) return ""
      const count = Tokenizer.lines(source, last, position)
      last = position
      return "\n".repeat(count)
    }

    let i = open + 1
    let type: string
    let name: string | undefined
    const props: Array<string> = []
    let key: string | undefined

    if (kindOf(i) === Tokenizer.JsxTagEnd) {
      used.add("Fragment")
      type = names.Fragment
    } else {
      const tag = tagName(i)
      name = tag.name
      type = tag.expression ? tag.name : JSON.stringify(tag.name)
      i = tag.next
      while (kindOf(i) !== Tokenizer.JsxTagEnd && kindOf(i) !== Tokenizer.JsxSelfClosing) {
        if (kindOf(i) === Tokenizer.JsxExpressionStart) {
          // A spread, {...props}
          if (!is(i + 1, "...")) fail("Expected ... in a JSX spread attribute", startOf(i + 1))
          const close = closing[i] ?? -1
          if (close === -1) fail("Unterminated JSX expression", startOf(i))
          const prefix = breaks(startOf(i))
          props.push(`${prefix}...${javascript(i + 2, close, endOf(i + 1), startOf(close))}`)
          last = startOf(close)
          i = close + 1
          continue
        }
        if (kindOf(i) !== Tokenizer.JsxName) fail("Unexpected token in a JSX element", startOf(i))
        const attributeStart = startOf(i)
        let attribute = text(i)
        i++
        if (is(i, ":") && kindOf(i + 1) === Tokenizer.JsxName) {
          attribute += `:${text(i + 1)}`
          i += 2
        }
        const prefix = breaks(attributeStart)
        let value = "true"
        if (is(i, "=")) {
          i++
          const valueKind = kindOf(i)
          if (valueKind === Tokenizer.JsxString) {
            value = JSON.stringify(decodeEntities(source.slice(startOf(i) + 1, endOf(i) - 1), startOf(i) + 1))
            i++
          } else if (valueKind === Tokenizer.JsxExpressionStart) {
            const expression = expressionOf(i)
            if (expression.code === undefined) fail("A JSX attribute's expression can't be empty", startOf(i))
            value = expression.code!
            last = startOf(expression.next - 1)
            i = expression.next
          } else if (valueKind === Tokenizer.JsxTagStart) {
            const element = compile(i)
            value = element.code
            last = element.end
            i = element.next
          } else {
            fail("Expected a JSX attribute value", startOf(i))
          }
        }
        if (attribute === "key") key = value
        else props.push(`${prefix}${property(attribute)}: ${value}`)
      }
    }

    // Children
    const children: Array<string> = []
    if (kindOf(i) === Tokenizer.JsxSelfClosing) {
      i++
    } else {
      i++
      for (;;) {
        const kind = kindOf(i)
        if (kind === Tokenizer.JsxText) {
          const value = textOf(startOf(i), endOf(i))
          if (value !== "") children.push(`${breaks(startOf(i))}${JSON.stringify(value)}`)
          i++
        } else if (kind === Tokenizer.JsxExpressionStart) {
          if (is(i + 1, "...")) fail("JSX spread children are not supported", startOf(i + 1))
          const prefix = breaks(startOf(i))
          const expression = expressionOf(i)
          if (expression.code !== undefined) {
            children.push(`${prefix}${expression.code}`)
            last = startOf(expression.next - 1)
          }
          i = expression.next
        } else if (kind === Tokenizer.JsxTagStart) {
          const prefix = breaks(startOf(i))
          const element = compile(i)
          children.push(`${prefix}${element.code}`)
          last = element.end
          i = element.next
        } else if (kind === Tokenizer.JsxClosingTagStart) {
          i++
          if (kindOf(i) === Tokenizer.JsxName) {
            const tag = tagName(i)
            if (tag.name !== name) {
              fail(`Expected </${name ?? ""}> to close <${name ?? ""}>, not </${tag.name}>`, startOf(i))
            }
            i = tag.next
          } else if (name !== undefined) {
            fail(`Expected </${name}> to close <${name}>`, startOf(i))
          }
          i++
          break
        } else {
          return fail("Unterminated JSX element", elementStart)
        }
      }
    }

    const end = endOf(i - 1)
    if (children.length === 1) props.push(`children: ${children[0]}`)
    else if (children.length > 1) props.push(`children: [${children.join(", ")}]`)
    const call = children.length > 1 ? "jsxs" : "jsx"
    used.add(call)
    const args = [type, props.length === 0 ? "{}" : `{ ${props.join(", ")} }`]
    if (key !== undefined) args.push(key)
    const code = `/* @__PURE__ */ ${names[call]}(${args.join(", ")}${breaks(end)})`
    return { code, next: i, end }
  }

  const body = javascript(0, n, 0, source.length)
  const imports = [...used].sort().map((name) => `${name} as ${names[name]}`).join(", ")
  const declaration = `import { ${imports} } from ${JSON.stringify(runtimeOf(importSource))};`
  // After a hashbang, which must stay first
  const at = source.startsWith("#!") ? source.search(/[\r\n\u2028\u2029]/) : 0
  if (at === -1) return `${body}\n${declaration}`
  const lineBreak = at === 0 ? 0 : source[at] === "\r" && source[at + 1] === "\n" ? 2 : 1
  return body.slice(0, at + lineBreak) + declaration + body.slice(at + lineBreak)
}
