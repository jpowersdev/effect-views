/**
 * Removes the whitespace a module doesn't need, token by token: indentation,
 * blank lines, and spaces wherever two tokens can't run together. Line breaks
 * stay only where they could matter, so that automatic semicolon insertion
 * and the rules about line breaks, such as after `return`, read the module
 * exactly as before; see lineBreakMatters. Comments must already be gone; the
 * bundler blanks them.
 */
import * as Tokenizer from "./Tokenizer.js"

/** Changes whenever the output changes for the same input, so bundled files get new names. */
export const version = 1

const isWordLike = (kind: number): boolean =>
  kind === Tokenizer.Word || kind === Tokenizer.Private || kind === Tokenizer.Number

/** Whether a statement may end after the token, so a line break after it may end the statement. */
const canEnd = (kind: number, text: string): boolean => {
  switch (kind) {
    case Tokenizer.Punctuator:
      return text === ")" || text === "]" || text === "}" || text === "++" || text === "--"
    case Tokenizer.TemplateHead:
    case Tokenizer.TemplateMiddle:
      return false
    default:
      return true
  }
}

/** Whether the two tokens would read differently, or as a comment, without a space between them. */
const needsSpace = (kind: number, text: string, nextKind: number, next: string): boolean =>
  (isWordLike(kind) && isWordLike(nextKind)) ||
  // "/a/g in x": the flags would take the word
  (kind === Tokenizer.Regex && isWordLike(nextKind)) ||
  // "1 .toString()": a number followed by a dot would take the dot
  (kind === Tokenizer.Number && next.startsWith(".")) ||
  // "a + +b" and "a - -b"
  (text.endsWith("+") && next.startsWith("+")) ||
  (text.endsWith("-") && next.startsWith("-")) ||
  // "a / /b/" and "a / *b": a comment otherwise
  (text.endsWith("/") && (next.startsWith("/") || next.startsWith("*"))) ||
  // "a < !--b": an HTML comment opener in scripts
  (text === "<" && next.startsWith("!"))

/** Keywords a line break must not follow without ending the statement, such as `return` before a value. */
const restricted = new Set(["return", "break", "continue", "throw", "yield", "async"])

/**
 * Whether a line break between the tokens could change how the module reads.
 * A semicolon is inserted at a line break only when the next token couldn't
 * continue the statement, such as a word after a value, and always after
 * `return` and the like, or before a `++` that follows a value. Before `.`,
 * `(`, an operator, or a closing bracket, the line break changes nothing.
 */
const lineBreakMatters = (kind: number, text: string, nextKind: number, next: string): boolean => {
  if (!canEnd(kind, text)) return false
  if (kind === Tokenizer.Word && restricted.has(text)) return true
  if (text === "++" || text === "--") return true
  switch (nextKind) {
    case Tokenizer.Word:
      return next !== "in" && next !== "instanceof"
    case Tokenizer.Private:
    case Tokenizer.Number:
    case Tokenizer.String:
      return true
    case Tokenizer.Punctuator:
      return next === "{" || next === "!" || next === "~" || next === "++" || next === "--"
    default:
      return false
  }
}

export const whitespace = (source: string): string => {
  const { tokens } = Tokenizer.scan(source)
  const parts: Array<string> = []
  let kind = -1
  let text = ""
  for (let index = 0; index < tokens.count; index++) {
    const nextKind = tokens.kinds[index]!
    const next = source.slice(tokens.starts[index]!, tokens.ends[index]!)
    if (index > 0) {
      if ((tokens.flags[index]! & Tokenizer.NewlineBefore) !== 0 && lineBreakMatters(kind, text, nextKind, next)) {
        parts.push("\n")
      }
      else if (needsSpace(kind, text, nextKind, next)) parts.push(" ")
    }
    parts.push(next)
    kind = nextKind
    text = next
  }
  return parts.join("")
}
