/**
 * A JavaScript lexer: a module's tokens, its comments, and the specifiers of
 * its imports and re-exports. It never parses: like es-module-lexer, it tells
 * a regular expression from a division by the token before the slash, so it
 * reads Effect's few megabytes in milliseconds. With `jsx`, it also reads JSX
 * elements where an expression can start, for Jsx.transform.
 *
 * @internal
 */
import * as Data from "effect/Data"

export interface Comment {
  /** The index of the comment's first character. */
  readonly start: number
  /** The index after its last character; a line comment ends before its line terminator. */
  readonly end: number
}

export interface Import {
  /** "static" for import and export declarations, "dynamic" for import() with a literal argument. */
  readonly kind: "static" | "dynamic"
  /** The specifier, with any escapes decoded. */
  readonly specifier: string
  /** The index of the specifier's opening quote. */
  readonly start: number
  /** The index after its closing quote. */
  readonly end: number
  readonly quote: "'" | "\"" | "`"
  /** Whether it has attributes, such as `with { type: "json" }`, or import() a second argument. */
  readonly attributes: boolean
}

/** The kinds of token. */
export const Word = 1
export const Private = 2
export const Punctuator = 3
export const String = 4
export const Number = 5
export const Regex = 6
/** A template without substitutions. */
export const Template = 7
/** A template up to its first `${`. */
export const TemplateHead = 8
/** From a substitution's `}` to the next `${`. */
export const TemplateMiddle = 9
/** From the last substitution's `}` to the closing backtick. */
export const TemplateTail = 10
/** JSX, read only with the jsx option: `<` opening an element or a fragment. */
export const JsxTagStart = 11
/** `</`, opening a closing tag. */
export const JsxClosingTagStart = 12
/** `>`, ending a tag. */
export const JsxTagEnd = 13
/** `/>`. */
export const JsxSelfClosing = 14
/** A tag or attribute name, which may contain `-`; `.` and `:` between names are Punctuators. */
export const JsxName = 15
/** An attribute's quoted value, which has no escapes. */
export const JsxString = 16
export const JsxText = 17
/** `{` opening an expression in an attribute or among children; the expression's tokens follow. */
export const JsxExpressionStart = 18
export const JsxExpressionEnd = 19

/** Flags: a line terminator comes before the token. */
export const NewlineBefore = 1
/** Flags: a `/*#__PURE__*\/` or `/* @__PURE__ *\/` comment comes right before the token. */
export const PureBefore = 2

/** The tokens, in arrays indexed alike. */
export interface Tokens {
  readonly count: number
  readonly kinds: Uint8Array
  readonly flags: Uint8Array
  readonly starts: Int32Array
  readonly ends: Int32Array
}

export interface Scan {
  readonly comments: ReadonlyArray<Comment>
  readonly imports: ReadonlyArray<Import>
  readonly tokens: Tokens
}

/** A string, template, comment, regular expression or JSX element that doesn't end, or a JSX mistake. */
export class TokenizerError extends Data.TaggedError("TokenizerError")<{
  readonly message: string
  readonly index: number
  readonly line: number
  readonly column: number
}> {}

const TAB = 9
const LF = 10
const VT = 11
const FF = 12
const CR = 13
const SPACE = 32
const BANG = 33
const DQUOTE = 34
const HASH = 35
const DOLLAR = 36
const PERCENT = 37
const AMPERSAND = 38
const QUOTE = 39
const OPEN_PAREN = 40
const CLOSE_PAREN = 41
const STAR = 42
const PLUS = 43
const COMMA = 44
const MINUS = 45
const DOT = 46
const SLASH = 47
const COLON = 58
const SEMICOLON = 59
const LESS = 60
const EQUALS = 61
const GREATER = 62
const QUESTION = 63
const OPEN_BRACKET = 91
const BACKSLASH = 92
const CLOSE_BRACKET = 93
const CARET = 94
const UNDERSCORE = 95
const BACKTICK = 96
const OPEN_BRACE = 123
const PIPE = 124
const CLOSE_BRACE = 125
const LS = 0x2028
const PS = 0x2029

/** What an open brace closes: a block, an object, a JSX expression, or (as its index) a template's substitution. */
const BLOCK = -1
const OBJECT = -2
const JSX = -3

/** Keywords after which a slash starts a regular expression rather than dividing. */
const expressionKeywords: ReadonlySet<string> = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
])

/** Keywords whose parenthesized condition may be followed by a regular expression: `if (x) /y/.test(z)`. */
const conditionKeywords: ReadonlySet<string> = new Set(["for", "if", "while", "with"])

const isDigit = (c: number): boolean => c >= 48 && c <= 57

export const isLineTerminator = (c: number): boolean => c === LF || c === CR || c === LS || c === PS

const isUnicodeWhitespace = (c: number): boolean =>
  c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f ||
  c === 0x3000 || c === LS || c === PS

/** Letters, digits, `$` and `_`, and, loosely, any other character that isn't whitespace. */
export const isIdentifierPart = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || isDigit(c) || c === DOLLAR || c === UNDERSCORE ||
  (c >= 0x80 && !isUnicodeWhitespace(c))

export const isIdentifierStart = (c: number): boolean => !isDigit(c) && (isIdentifierPart(c) || c === BACKSLASH)

/** The 1-based line and column of an index, counting `\r\n` as one line terminator. */
export const position = (source: string, index: number): { readonly line: number; readonly column: number } => {
  let line = 1
  let lineStart = 0
  const end = Math.min(index, source.length)
  for (let i = 0; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c === LF || c === LS || c === PS || (c === CR && source.charCodeAt(i + 1) !== LF)) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: index - lineStart + 1 }
}

/** How many line terminators a range has, counting `\r\n` as one. */
export const lines = (source: string, start: number, end: number): number => {
  let count = 0
  for (let i = start; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c === LF || c === LS || c === PS || (c === CR && source.charCodeAt(i + 1) !== LF)) count++
  }
  return count
}

const escapes = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g

const simpleEscapes: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0"
}

const unescape = (
  _match: string,
  codePoint: string | undefined,
  unit: string | undefined,
  byte: string | undefined,
  character: string | undefined
): string => {
  if (codePoint !== undefined) return globalThis.String.fromCodePoint(parseInt(codePoint, 16))
  const code = unit ?? byte
  if (code !== undefined) return globalThis.String.fromCharCode(parseInt(code, 16))
  if (character === undefined) return ""
  // A line continuation
  if (character === "\r\n" || isLineTerminator(character.charCodeAt(0))) return ""
  return simpleEscapes[character] ?? character
}

/** A string literal's value, from the text between its quotes. */
export const decode = (raw: string): string => raw.includes("\\") ? raw.replace(escapes, unescape) : raw

/** The text of a token. */
export const text = (source: string, tokens: Tokens, index: number): string =>
  source.slice(tokens.starts[index]!, tokens.ends[index]!)

/** Whether a token's text is `value`, without slicing. */
export const is = (source: string, tokens: Tokens, index: number, value: string): boolean => {
  if (index < 0 || index >= tokens.count) return false
  const start = tokens.starts[index]!
  return tokens.ends[index]! - start === value.length && source.startsWith(value, start)
}

const isPureComment = (source: string, start: number, end: number): boolean => {
  if (end - start > 24) return false
  const body = source.slice(start + 2, end - 2).trim()
  return body === "#__PURE__" || body === "@__PURE__"
}

export interface Options {
  /** Read JSX where an expression can start, as Jsx.transform needs. */
  readonly jsx?: boolean
}

/**
 * Finds a module's tokens, comments and imports. Throws a TokenizerError when
 * a string, template, comment or regular expression doesn't end.
 */
export const scan = (source: string, options?: Options): Scan => {
  const jsx = options?.jsx === true
  const length = source.length
  const comments: Array<Comment> = []
  const imports: Array<Import> = []
  /** For each open brace, what it closes: BLOCK, OBJECT, JSX, or the index of the template it substitutes into. */
  const braces: Array<number> = []
  /** For each open parenthesis, whether it holds the condition of if, while, for or with. */
  const parens: Array<boolean> = []

  let capacity = Math.max(64, length >> 2)
  let kinds = new Uint8Array(capacity)
  let flags = new Uint8Array(capacity)
  let starts = new Int32Array(capacity)
  let ends = new Int32Array(capacity)
  let count = 0
  let newline = false
  let pure = false

  const emit = (kind: number, start: number, end: number): void => {
    if (count === capacity) {
      capacity *= 2
      const grow = <A extends Uint8Array | Int32Array>(array: A, make: (size: number) => A): A => {
        const grown = make(capacity)
        grown.set(array)
        return grown
      }
      kinds = grow(kinds, (size) => new Uint8Array(size))
      flags = grow(flags, (size) => new Uint8Array(size))
      starts = grow(starts, (size) => new Int32Array(size))
      ends = grow(ends, (size) => new Int32Array(size))
    }
    kinds[count] = kind
    flags[count] = (newline ? NewlineBefore : 0) | (pure ? PureBefore : 0)
    starts[count] = start
    ends[count] = end
    count++
    newline = false
    pure = false
  }

  // What the previous token allows next
  let regexAllowed = true
  let blockAllowed = true
  let afterDot = false
  let lastWord: string | undefined
  let wordBefore: string | undefined

  const fail = (message: string, index: number): never => {
    const { column, line } = position(source, index)
    throw new TokenizerError({ message, index, line, column })
  }

  const punctuator = (): void => {
    regexAllowed = true
    blockAllowed = false
    afterDot = false
    lastWord = undefined
    wordBefore = undefined
  }

  const value = (): void => {
    regexAllowed = false
    blockAllowed = false
    afterDot = false
    lastWord = undefined
    wordBefore = undefined
  }

  const word = (name: string | undefined): void => {
    const expression = name !== undefined && expressionKeywords.has(name)
    regexAllowed = expression
    // `else {` and `do {` open blocks, `return {` an object, and `class A {` a class body
    blockAllowed = !expression || name === "else" || name === "do"
    afterDot = false
    wordBefore = lastWord
    lastWord = name
  }

  const lineEnd = (from: number): number => {
    let i = from
    while (i < length && !isLineTerminator(source.charCodeAt(i))) i++
    return i
  }

  const wordEnd = (from: number): number => {
    let i = from
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === BACKSLASH) {
        // A unicode escape, \uXXXX or \u{X...}
        i += 2
        if (source.charCodeAt(i) === OPEN_BRACE) {
          const close = source.indexOf("}", i)
          i = close === -1 ? length : close + 1
        }
      } else if (isIdentifierPart(c)) {
        i++
      } else {
        break
      }
    }
    return i
  }

  const digitsEnd = (from: number): number => {
    let i = from
    for (let c = source.charCodeAt(i); isDigit(c) || c === UNDERSCORE; c = source.charCodeAt(++i));
    return i
  }

  const numberEnd = (start: number): number => {
    if (source.charCodeAt(start) === 48) {
      const radix = source.charCodeAt(start + 1) | 0x20
      // 0x, 0o and 0b: their digits and a BigInt's n are all identifier characters
      if (radix === 120 || radix === 111 || radix === 98) return wordEnd(start + 2)
    }
    let i = digitsEnd(start)
    if (source.charCodeAt(i) === DOT) i = digitsEnd(i + 1)
    if ((source.charCodeAt(i) | 0x20) === 101) {
      let exponent = i + 1
      const sign = source.charCodeAt(exponent)
      if (sign === PLUS || sign === MINUS) exponent++
      if (isDigit(source.charCodeAt(exponent))) i = digitsEnd(exponent)
    }
    if (source.charCodeAt(i) === 110) i++
    return i
  }

  /** The index after a punctuator, longest first: `>>>=`, `?.` (but not `?.5`), `...`. */
  const punctuatorEnd = (i: number, c: number): number => {
    const next = source.charCodeAt(i + 1)
    const third = source.charCodeAt(i + 2)
    switch (c) {
      case DOT:
        return next === DOT && third === DOT ? i + 3 : i + 1
      case QUESTION:
        if (next === DOT && !isDigit(third)) return i + 2
        if (next === QUESTION) return third === EQUALS ? i + 3 : i + 2
        return i + 1
      case EQUALS:
        if (next === GREATER) return i + 2
        if (next === EQUALS) return third === EQUALS ? i + 3 : i + 2
        return i + 1
      case BANG:
        if (next === EQUALS) return third === EQUALS ? i + 3 : i + 2
        return i + 1
      case PLUS:
      case MINUS:
        return next === c || next === EQUALS ? i + 2 : i + 1
      case STAR:
        if (next === STAR) return third === EQUALS ? i + 3 : i + 2
        return next === EQUALS ? i + 2 : i + 1
      case PERCENT:
      case CARET:
        return next === EQUALS ? i + 2 : i + 1
      case LESS:
        if (next === LESS) return third === EQUALS ? i + 3 : i + 2
        return next === EQUALS ? i + 2 : i + 1
      case GREATER:
        if (next === GREATER) {
          if (third === GREATER) return source.charCodeAt(i + 3) === EQUALS ? i + 4 : i + 3
          return third === EQUALS ? i + 3 : i + 2
        }
        return next === EQUALS ? i + 2 : i + 1
      case AMPERSAND:
      case PIPE:
        if (next === c) return third === EQUALS ? i + 3 : i + 2
        return next === EQUALS ? i + 2 : i + 1
      default:
        return i + 1
    }
  }

  /** The index after a string literal's closing quote, or -1 if it doesn't close. */
  const stringEnd = (start: number): number => {
    const quote = source.charCodeAt(start)
    let i = start + 1
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === quote) return i + 1
      if (c === BACKSLASH) {
        i += source.charCodeAt(i + 1) === CR && source.charCodeAt(i + 2) === LF ? 3 : 2
      } else if (c === LF || c === CR) {
        return -1
      } else {
        i++
      }
    }
    return -1
  }

  /** The index after a template without substitutions, or -1 if it has one or doesn't close. */
  const plainTemplateEnd = (start: number): number => {
    let i = start + 1
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === BACKTICK) return i + 1
      if (c === BACKSLASH) i += 2
      else if (c === DOLLAR && source.charCodeAt(i + 1) === OPEN_BRACE) return -1
      else i++
    }
    return -1
  }

  /**
   * Scans a template's characters, from its backtick or from the `}` closing
   * a substitution, to its closing backtick or its next `${`.
   */
  const template = (tokenStart: number, start: number, continuation: boolean): number => {
    let i = tokenStart + 1
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === BACKTICK) {
        emit(continuation ? TemplateTail : Template, tokenStart, i + 1)
        value()
        return i + 1
      }
      if (c === BACKSLASH) {
        i += 2
      } else if (c === DOLLAR && source.charCodeAt(i + 1) === OPEN_BRACE) {
        emit(continuation ? TemplateMiddle : TemplateHead, tokenStart, i + 2)
        braces.push(start)
        punctuator()
        return i + 2
      } else {
        i++
      }
    }
    return fail("Unterminated template literal", start)
  }

  const regexEnd = (start: number): number => {
    let i = start + 1
    let inClass = false
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === BACKSLASH) {
        if (isLineTerminator(source.charCodeAt(i + 1))) break
        i += 2
        continue
      }
      if (isLineTerminator(c)) break
      if (inClass) {
        if (c === CLOSE_BRACKET) inClass = false
      } else if (c === OPEN_BRACKET) {
        inClass = true
      } else if (c === SLASH) {
        // The flags
        return wordEnd(i + 1)
      }
      i++
    }
    return fail("Unterminated regular expression", start)
  }

  const blockComment = (start: number): number => {
    const close = source.indexOf("*/", start + 2)
    if (close === -1) return fail("Unterminated comment", start)
    const end = close + 2
    comments.push({ start, end })
    if (isPureComment(source, start, end)) pure = true
    if (!newline && lines(source, start, end) > 0) newline = true
    return end
  }

  /** The next index from `from` that isn't whitespace or in a comment, without recording the comments. */
  const skip = (from: number): number => {
    let i = from
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === SPACE || c === LF || c === TAB || c === CR || c === VT || c === FF || isUnicodeWhitespace(c)) {
        i++
      } else if (c === SLASH && source.charCodeAt(i + 1) === SLASH) {
        i = lineEnd(i + 2)
      } else if (c === SLASH && source.charCodeAt(i + 1) === STAR) {
        const close = source.indexOf("*/", i + 2)
        if (close === -1) return length
        i = close + 2
      } else {
        return i
      }
    }
    return i
  }

  const record = (entry: Import): void => {
    // A declaration read ahead never overlaps another, but never record a specifier twice
    const last = imports[imports.length - 1]
    if (last === undefined || last.start < entry.start) imports.push(entry)
  }

  /** Whether `with { ... }` or `assert { ... }` follows a declaration's specifier. */
  const attributesAt = (from: number): boolean => {
    const start = skip(from)
    const end = wordEnd(start)
    const keyword = source.slice(start, end)
    return (keyword === "with" || keyword === "assert") && source.charCodeAt(skip(end)) === OPEN_BRACE
  }

  /**
   * Reads ahead through an import or export declaration's bindings to its
   * specifier: the string after `from`, or the string straight after
   * `import`. Gives up at anything a declaration can't contain, as in
   * `class { import = 1 }`, leaving the tokens to the main loop.
   */
  const declarationAt = (from: number, isImport: boolean): void => {
    let i = from
    let first = true
    let inBraces = false
    let afterBraces = false
    let afterFrom = false
    while (i < length) {
      i = skip(i)
      const c = source.charCodeAt(i)
      if (c === QUOTE || c === DQUOTE) {
        const end = stringEnd(i)
        if (end === -1) return
        if (!inBraces && (afterFrom || (first && isImport))) {
          record({
            kind: "static",
            specifier: decode(source.slice(i + 1, end - 1)),
            start: i,
            end,
            quote: c === QUOTE ? "'" : "\"",
            attributes: attributesAt(end)
          })
          return
        }
        // A binding's name, as in `{ "a-b" as c }` or `* as "d"`
        if (afterBraces) return
        i = end
        afterFrom = false
      } else if (isIdentifierStart(c)) {
        const end = wordEnd(i)
        const name = source.slice(i, end)
        if (!inBraces && (name === "import" || name === "export")) return
        if (afterBraces && name !== "from") return
        afterFrom = !inBraces && name === "from"
        afterBraces = false
        i = end
      } else if (c === OPEN_BRACE && !inBraces && !afterBraces) {
        inBraces = true
        afterFrom = false
        i++
      } else if (c === CLOSE_BRACE && inBraces) {
        inBraces = false
        afterBraces = true
        i++
      } else if ((c === STAR || c === COMMA) && !afterBraces) {
        afterFrom = false
        i++
      } else {
        return
      }
      first = false
    }
  }

  const dynamicImportAt = (from: number): void => {
    const start = skip(from)
    const c = source.charCodeAt(start)
    const end = c === QUOTE || c === DQUOTE ? stringEnd(start) : c === BACKTICK ? plainTemplateEnd(start) : -1
    if (end === -1) return
    let next = skip(end)
    let attributes = false
    if (source.charCodeAt(next) === COMMA) {
      next = skip(next + 1)
      attributes = source.charCodeAt(next) !== CLOSE_PAREN
    } else if (source.charCodeAt(next) !== CLOSE_PAREN) {
      // Not a literal, as in import("./" + name): left alone
      return
    }
    record({
      kind: "dynamic",
      specifier: decode(source.slice(start + 1, end - 1)),
      start,
      end,
      quote: c === QUOTE ? "'" : c === DQUOTE ? "\"" : "`",
      attributes
    })
  }

  /** After `import`: a declaration, import(), or import.meta. */
  const importAt = (from: number): void => {
    const next = skip(from)
    const c = source.charCodeAt(next)
    if (c === OPEN_PAREN) dynamicImportAt(next + 1)
    else if (c !== DOT) declarationAt(next, true)
  }

  /** After `export`: only `export * ... from` and `export { ... } from` import anything. */
  const exportAt = (from: number): void => {
    const next = skip(from)
    const c = source.charCodeAt(next)
    if (c === STAR || c === OPEN_BRACE) declarationAt(next, false)
  }

  // JSX ---------------------------------------------------------------------

  /** Whether a `<` where an expression can start opens TypeScript type parameters, `<T,>` or `<T extends U>`, not JSX. */
  const isTypeParameters = (at: number): boolean => {
    const name = skip(at + 1)
    if (!isIdentifierStart(source.charCodeAt(name))) return false
    const after = skip(wordEnd(name))
    if (source.charCodeAt(after) === COMMA) return true
    const end = wordEnd(after)
    if (source.slice(after, end) !== "extends") return false
    const next = source.charCodeAt(skip(end))
    return next !== EQUALS && next !== GREATER && next !== SLASH
  }

  /** Skips whitespace and comments inside a tag. */
  const tagSpace = (from: number): number => {
    let i = from
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === SLASH && source.charCodeAt(i + 1) === SLASH) {
        const end = lineEnd(i + 2)
        comments.push({ start: i, end })
        i = end
      } else if (c === SLASH && source.charCodeAt(i + 1) === STAR) {
        i = blockComment(i)
      } else if (c === SPACE || c === TAB || isLineTerminator(c) || c === VT || c === FF || isUnicodeWhitespace(c)) {
        i++
      } else {
        break
      }
    }
    return i
  }

  /** A JSX name: identifier characters and `-`. */
  const jsxNameEnd = (from: number): number => {
    let i = from
    while (i < length) {
      const c = source.charCodeAt(i)
      if (isIdentifierPart(c) || c === MINUS) i++
      else break
    }
    return i
  }

  /** An element's name, such as `div`, `my-element`, `A.B` or `svg:rect`. */
  const tagName = (from: number): number => {
    let name = from
    for (;;) {
      if (!isIdentifierStart(source.charCodeAt(name))) return fail("Expected a JSX element name", name)
      const end = jsxNameEnd(name)
      emit(JsxName, name, end)
      const separator = tagSpace(end)
      const c = source.charCodeAt(separator)
      if (c !== DOT && c !== COLON) return end
      emit(Punctuator, separator, separator + 1)
      name = tagSpace(separator + 1)
    }
  }

  /** An expression in braces, read as JavaScript up to its closing brace. */
  const expression = (from: number, element: number): number => {
    emit(JsxExpressionStart, from, from + 1)
    braces.push(JSX)
    punctuator()
    const end = js(from + 1)
    if (end === -1) return fail("Unterminated JSX element", element)
    return end
  }

  const element = (start: number): number => {
    emit(JsxTagStart, start, start + 1)
    let i = tagSpace(start + 1)
    if (source.charCodeAt(i) === GREATER) {
      // A fragment
      emit(JsxTagEnd, i, i + 1)
      return children(i + 1, start, "")
    }
    const nameStart = i
    i = tagName(i)
    const name = source.slice(nameStart, i).replace(/\s+/g, "")
    for (;;) {
      i = tagSpace(i)
      const c = source.charCodeAt(i)
      if (c === SLASH && source.charCodeAt(i + 1) === GREATER) {
        emit(JsxSelfClosing, i, i + 2)
        return i + 2
      }
      if (c === GREATER) {
        emit(JsxTagEnd, i, i + 1)
        return children(i + 1, start, name)
      }
      if (c === OPEN_BRACE) {
        // A spread, {...props}
        i = expression(i, start)
      } else if (isIdentifierStart(c)) {
        const nameEnd = jsxNameEnd(i)
        emit(JsxName, i, nameEnd)
        i = attribute(nameEnd, start)
      } else if (i >= length) {
        return fail("Unterminated JSX element", start)
      } else {
        return fail("Unexpected character in a JSX element", i)
      }
    }
  }

  /** After an attribute's name: `:name`, and `=` with a string, an expression or an element. */
  const attribute = (from: number, start: number): number => {
    let i = tagSpace(from)
    if (source.charCodeAt(i) === COLON) {
      emit(Punctuator, i, i + 1)
      const name = tagSpace(i + 1)
      i = jsxNameEnd(name)
      emit(JsxName, name, i)
      i = tagSpace(i)
    }
    if (source.charCodeAt(i) !== EQUALS) return i
    emit(Punctuator, i, i + 1)
    i = tagSpace(i + 1)
    const c = source.charCodeAt(i)
    if (c === QUOTE || c === DQUOTE) {
      const close = source.indexOf(c === QUOTE ? "'" : "\"", i + 1)
      if (close === -1) return fail("Unterminated JSX attribute string", i)
      emit(JsxString, i, close + 1)
      return close + 1
    }
    if (c === OPEN_BRACE) return expression(i, start)
    if (c === LESS) return element(i)
    return fail("Expected a JSX attribute value", i)
  }

  /** An element's children, then its closing tag, which must name it. */
  const children = (from: number, start: number, name: string): number => {
    let i = from
    for (;;) {
      const textStart = i
      while (i < length) {
        const c = source.charCodeAt(i)
        if (c === LESS || c === OPEN_BRACE) break
        i++
      }
      if (i > textStart) emit(JsxText, textStart, i)
      if (i >= length) return fail("Unterminated JSX element", start)
      if (source.charCodeAt(i) === OPEN_BRACE) {
        i = expression(i, start)
        continue
      }
      const next = tagSpace(i + 1)
      if (source.charCodeAt(next) !== SLASH) {
        i = element(i)
        continue
      }
      emit(JsxClosingTagStart, i, next + 1)
      i = tagSpace(next + 1)
      const closingStart = i
      if (source.charCodeAt(i) !== GREATER) i = tagSpace(tagName(i))
      const closing = source.slice(closingStart, i).replace(/\s+/g, "")
      if (closing !== name) {
        return fail(
          name === "" ? `Expected </> to close <>, not </${closing}>` : `Expected </${name}> to close <${name}>, not </${closing}>`,
          closingStart
        )
      }
      if (source.charCodeAt(i) !== GREATER) return fail("Expected > to close a JSX tag", i)
      emit(JsxTagEnd, i, i + 1)
      return i + 1
    }
  }

  // JavaScript ---------------------------------------------------------------

  /**
   * Reads JavaScript from `from` to the end, or, when the innermost open brace
   * is a JSX expression's, to the index after its closing brace; -1 if the
   * source ends first.
   */
  const js = (from: number): number => {
    let i = from
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === SPACE || c === TAB) {
        i++
        continue
      }
      if (c === LF || c === CR) {
        newline = true
        i++
        continue
      }

      if (isIdentifierStart(c) || c === HASH) {
        const start = i
        i = wordEnd(c === HASH ? i + 1 : i)
        emit(c === HASH ? Private : Word, start, i)
        if (c === HASH || afterDot) {
          // A private name or a property, never a keyword: `x.import`, `x?.return / 2`
          word(undefined)
          continue
        }
        // Keywords are lowercase and at most 10 characters long
        const name = i - start <= 10 && c >= 97 && c <= 122 ? source.slice(start, i) : undefined
        if (name === "import") importAt(i)
        else if (name === "export") exportAt(i)
        word(name)
        continue
      }

      if (isDigit(c) || (c === DOT && isDigit(source.charCodeAt(i + 1)))) {
        const end = numberEnd(i)
        emit(Number, i, end)
        i = end
        value()
        continue
      }

      switch (c) {
        case SLASH: {
          const next = source.charCodeAt(i + 1)
          if (next === SLASH) {
            const end = lineEnd(i + 2)
            comments.push({ start: i, end })
            i = end
          } else if (next === STAR) {
            i = blockComment(i)
          } else if (regexAllowed) {
            const end = regexEnd(i)
            emit(Regex, i, end)
            i = end
            value()
          } else {
            const end = next === EQUALS ? i + 2 : i + 1
            emit(Punctuator, i, end)
            i = end
            punctuator()
          }
          continue
        }
        case QUOTE:
        case DQUOTE: {
          const end = stringEnd(i)
          if (end === -1) return fail("Unterminated string literal", i)
          emit(String, i, end)
          i = end
          value()
          continue
        }
        case BACKTICK: {
          i = template(i, i, false)
          continue
        }
        case OPEN_PAREN: {
          const condition = lastWord !== undefined &&
            (conditionKeywords.has(lastWord) || (lastWord === "await" && wordBefore === "for"))
          emit(Punctuator, i, i + 1)
          parens.push(condition)
          punctuator()
          i++
          continue
        }
        case CLOSE_PAREN: {
          const condition = parens.pop() ?? false
          emit(Punctuator, i, i + 1)
          value()
          regexAllowed = condition
          blockAllowed = true
          i++
          continue
        }
        case OPEN_BRACE: {
          emit(Punctuator, i, i + 1)
          braces.push(blockAllowed ? BLOCK : OBJECT)
          punctuator()
          blockAllowed = true
          i++
          continue
        }
        case CLOSE_BRACE: {
          const open = braces.pop() ?? OBJECT
          if (open >= 0) {
            i = template(i, open, true)
            continue
          }
          if (open === JSX) {
            emit(JsxExpressionEnd, i, i + 1)
            return i + 1
          }
          emit(Punctuator, i, i + 1)
          value()
          // After a block, a statement starts; after an object, an operator follows
          regexAllowed = open === BLOCK
          blockAllowed = true
          i++
          continue
        }
        case LESS: {
          if (jsx && regexAllowed && !isTypeParameters(i)) {
            i = element(i)
            value()
            continue
          }
          break
        }
        default: {
          if (c === VT || c === FF || isUnicodeWhitespace(c)) {
            if (c === LS || c === PS) newline = true
            i++
            continue
          }
        }
      }

      // Any other punctuator
      const end = punctuatorEnd(i, c)
      emit(Punctuator, i, end)
      const size = end - i
      if (c === CLOSE_BRACKET) {
        value()
      } else if ((c === PLUS || c === MINUS) && size === 2 && source.charCodeAt(i + 1) === c) {
        // Taken as postfix, `x++ / 2`: a prefix ++ is never followed by a slash
        value()
      } else {
        punctuator()
        if (c === SEMICOLON || (c === EQUALS && size === 2 && source.charCodeAt(i + 1) === GREATER)) {
          blockAllowed = true
        } else if ((c === DOT && size === 1) || (c === QUESTION && size === 2 && source.charCodeAt(i + 1) === DOT)) {
          afterDot = true
        }
      }
      i = end
    }
    return braces.includes(JSX) ? -1 : length
  }

  let start = 0
  if (source.charCodeAt(0) === HASH && source.charCodeAt(1) === BANG) {
    start = lineEnd(2)
    comments.push({ start: 0, end: start })
  }
  js(start)

  for (let open = braces.length - 1; open >= 0; open--) {
    const templateStart = braces[open]!
    if (templateStart >= 0) fail("Unterminated template literal", templateStart)
  }

  return {
    comments,
    imports,
    tokens: {
      count,
      kinds: kinds.subarray(0, count),
      flags: flags.subarray(0, count),
      starts: starts.subarray(0, count),
      ends: ends.subarray(0, count)
    }
  }
}
