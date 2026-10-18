/**
 * A JavaScript lexer that finds what the bundler needs from a module: its
 * comments, and the specifiers of its imports and re-exports. It never parses:
 * like es-module-lexer, it tells a regular expression from a division by the
 * token before the slash, so it reads Effect's few megabytes in milliseconds.
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

export interface Scan {
  readonly comments: ReadonlyArray<Comment>
  readonly imports: ReadonlyArray<Import>
}

/** A string, template, comment or regular expression that doesn't end. */
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
const QUOTE = 39
const OPEN_PAREN = 40
const CLOSE_PAREN = 41
const STAR = 42
const PLUS = 43
const COMMA = 44
const MINUS = 45
const DOT = 46
const SLASH = 47
const SEMICOLON = 59
const EQUALS = 61
const GREATER = 62
const QUESTION = 63
const OPEN_BRACKET = 91
const BACKSLASH = 92
const CLOSE_BRACKET = 93
const UNDERSCORE = 95
const BACKTICK = 96
const OPEN_BRACE = 123
const CLOSE_BRACE = 125
const LS = 0x2028
const PS = 0x2029

/** What an open brace closes: a block, an object, or (as its index) a template's substitution. */
const BLOCK = -1
const OBJECT = -2

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

const isLineTerminator = (c: number): boolean => c === LF || c === CR || c === LS || c === PS

const isUnicodeWhitespace = (c: number): boolean =>
  c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f ||
  c === 0x3000 || c === LS || c === PS

/** Letters, digits, `$` and `_`, and, loosely, any other character that isn't whitespace. */
const isIdentifierPart = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || isDigit(c) || c === DOLLAR || c === UNDERSCORE ||
  (c >= 0x80 && !isUnicodeWhitespace(c))

const isIdentifierStart = (c: number): boolean => !isDigit(c) && (isIdentifierPart(c) || c === BACKSLASH)

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

const escapes = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g

const unescape = (
  _match: string,
  codePoint: string | undefined,
  unit: string | undefined,
  byte: string | undefined,
  character: string | undefined
): string => {
  if (codePoint !== undefined) return String.fromCodePoint(parseInt(codePoint, 16))
  const code = unit ?? byte
  if (code !== undefined) return String.fromCharCode(parseInt(code, 16))
  switch (character) {
    case "n":
      return "\n"
    case "r":
      return "\r"
    case "t":
      return "\t"
    case "b":
      return "\b"
    case "f":
      return "\f"
    case "v":
      return "\v"
    case "0":
      return "\0"
    case "\r\n":
    case "\n":
    case "\r":
    case " ":
    case " ":
      // A line continuation
      return ""
    default:
      return character ?? ""
  }
}

/** A string literal's value, from the text between its quotes; specifiers rarely have escapes. */
const decode = (raw: string): string => raw.includes("\\") ? raw.replace(escapes, unescape) : raw

/**
 * Finds a module's comments and imports. Throws a TokenizerError when a
 * string, template, comment or regular expression doesn't end.
 */
export const scan = (source: string): Scan => {
  const length = source.length
  const comments: Array<Comment> = []
  const imports: Array<Import> = []
  /** For each open brace, what it closes: BLOCK, OBJECT, or the index of the template it substitutes into. */
  const braces: Array<number> = []
  /** For each open parenthesis, whether it holds the condition of if, while, for or with. */
  const parens: Array<boolean> = []

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

  /** Scans a template's characters from after a backtick, or after the `}` closing a substitution. */
  const template = (from: number, start: number): number => {
    let i = from
    while (i < length) {
      const c = source.charCodeAt(i)
      if (c === BACKTICK) {
        value()
        return i + 1
      }
      if (c === BACKSLASH) {
        i += 2
      } else if (c === DOLLAR && source.charCodeAt(i + 1) === OPEN_BRACE) {
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

  let i = 0
  if (source.charCodeAt(0) === HASH && source.charCodeAt(1) === BANG) {
    i = lineEnd(2)
    comments.push({ start: 0, end: i })
  }

  while (i < length) {
    const c = source.charCodeAt(i)
    if (c === SPACE || c === LF || c === TAB || c === CR) {
      i++
      continue
    }

    if (isIdentifierStart(c) || c === HASH) {
      const start = i
      i = wordEnd(c === HASH ? i + 1 : i)
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
      i = numberEnd(i)
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
          const close = source.indexOf("*/", i + 2)
          if (close === -1) return fail("Unterminated comment", i)
          comments.push({ start: i, end: close + 2 })
          i = close + 2
        } else if (regexAllowed) {
          i = regexEnd(i)
          value()
        } else {
          i += next === EQUALS ? 2 : 1
          punctuator()
        }
        continue
      }
      case QUOTE:
      case DQUOTE: {
        const end = stringEnd(i)
        if (end === -1) return fail("Unterminated string literal", i)
        i = end
        value()
        continue
      }
      case BACKTICK: {
        i = template(i + 1, i)
        continue
      }
      case OPEN_PAREN: {
        const condition = lastWord !== undefined &&
          (conditionKeywords.has(lastWord) || (lastWord === "await" && wordBefore === "for"))
        parens.push(condition)
        punctuator()
        i++
        continue
      }
      case CLOSE_PAREN: {
        const condition = parens.pop() ?? false
        value()
        regexAllowed = condition
        blockAllowed = true
        i++
        continue
      }
      case OPEN_BRACE: {
        braces.push(blockAllowed ? BLOCK : OBJECT)
        punctuator()
        blockAllowed = true
        i++
        continue
      }
      case CLOSE_BRACE: {
        const open = braces.pop() ?? OBJECT
        if (open >= 0) {
          i = template(i + 1, open)
          continue
        }
        value()
        // After a block, a statement starts; after an object, an operator follows
        regexAllowed = open === BLOCK
        blockAllowed = true
        i++
        continue
      }
      case CLOSE_BRACKET: {
        value()
        i++
        continue
      }
      case SEMICOLON: {
        punctuator()
        blockAllowed = true
        i++
        continue
      }
      case DOT: {
        const spread = source.charCodeAt(i + 1) === DOT && source.charCodeAt(i + 2) === DOT
        punctuator()
        afterDot = !spread
        i += spread ? 3 : 1
        continue
      }
      case QUESTION: {
        const next = source.charCodeAt(i + 1)
        punctuator()
        if (next === DOT && !isDigit(source.charCodeAt(i + 2))) {
          afterDot = true
          i += 2
        } else {
          i += next === QUESTION ? 2 : 1
        }
        continue
      }
      case PLUS:
      case MINUS: {
        if (source.charCodeAt(i + 1) === c) {
          // Taken as postfix, `x++ / 2`: a prefix ++ is never followed by a slash
          value()
          i += 2
        } else {
          punctuator()
          i++
        }
        continue
      }
      case EQUALS: {
        const next = source.charCodeAt(i + 1)
        punctuator()
        if (next === GREATER) {
          blockAllowed = true
          i += 2
        } else if (next === EQUALS) {
          i += source.charCodeAt(i + 2) === EQUALS ? 3 : 2
        } else {
          i++
        }
        continue
      }
      default: {
        if (c === VT || c === FF || isUnicodeWhitespace(c)) {
          i++
          continue
        }
        punctuator()
        i++
      }
    }
  }

  for (let open = braces.length - 1; open >= 0; open--) {
    const start = braces[open]!
    if (start >= 0) fail("Unterminated template literal", start)
  }

  return { comments, imports }
}
