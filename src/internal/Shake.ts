/**
 * Tree-shaking that keeps one file per module. Each module is split into its
 * top-level statements, which are told pure or not and linked to the
 * module-scope names they use; marking then keeps what the entries reach, and
 * rendering blanks the rest and trims import and export lists, so that every
 * file stays an ES module the browser links as it is.
 *
 * Purity follows the usual bundler rules: function declarations, literals,
 * member reads and operators run nothing, nor do calls and `new` marked
 * `/*#__PURE__*\/`, nor function and arrow bodies. Anything uncertain counts as
 * having side effects, which is always safe.
 *
 * @internal
 */
import * as Tokenizer from "./Tokenizer.js"

export type Kind =
  | "import"
  | "exportFrom"
  | "exportStar"
  | "exportList"
  | "exportDefault"
  | "variable"
  | "function"
  | "class"
  | "other"

/** A name in an import clause or an export list, as written (an identifier, or a string with its quotes) and decoded. */
export interface Name {
  readonly raw: string
  readonly name: string
}

export interface Specifier {
  /** In an import, the export read; in an export list, the local name; in `export { … } from`, the export read. */
  readonly from: Name
  /** In an import, the local binding; otherwise the name exported. */
  readonly to: Name
}

export interface Statement {
  readonly kind: Kind
  /** The index of its first character and the index after its last. */
  readonly start: number
  readonly end: number
  /** Whether running it could do anything but define names. */
  readonly pure: boolean
  /** The module-scope names it declares. */
  readonly declares: ReadonlyArray<string>
  /** The module-scope names it uses. */
  readonly references: ReadonlyArray<string>
  /** For each namespace import it uses, the members it reads, or "escape" when it uses the namespace otherwise. */
  readonly namespaces: ReadonlyMap<string, ReadonlySet<string> | "escape">
  /** For imports and re-exports: the index, in Scan.imports, of its specifier. */
  readonly source: number
  /** For imports: the default binding, the namespace binding and the named bindings. */
  readonly defaultBinding: string | undefined
  readonly namespaceBinding: string | undefined
  /** For imports, export lists and `export { … } from`. */
  readonly specifiers: ReadonlyArray<Specifier>
  /** For `export * as ns from`: the name exported. */
  readonly namespaceExport: Name | undefined
}

export interface Binding {
  /** The export it reads: a name, "default", or "*" for a namespace. */
  readonly imported: string
  /** The index, in Scan.imports, of its specifier. */
  readonly source: number
}

export type Export =
  | { readonly _tag: "Local"; readonly local: string }
  | { readonly _tag: "Statement"; readonly statement: number }

export interface Analysis {
  readonly statements: ReadonlyArray<Statement>
  /** Import bindings, by local name. */
  readonly bindings: ReadonlyMap<string, Binding>
  /** The statements that declare each module-scope name. */
  readonly declarations: ReadonlyMap<string, ReadonlyArray<number>>
  /** What the module exports itself, by name. */
  readonly exports: ReadonlyMap<string, Export>
  /** What it re-exports by name from another module: an export's name, or "*" for `export * as ns`. */
  readonly reexports: ReadonlyMap<string, Binding>
  /** The specifiers of its `export * from`, as indexes in Scan.imports. */
  readonly stars: ReadonlyArray<number>
  /** The statement holding each literal import(), by its index in Scan.imports. */
  readonly dynamic: ReadonlyMap<number, number>
}

const W = Tokenizer.Word

/** Keywords after which a line break doesn't end a statement, since an operand must follow. */
const nonEnding: ReadonlySet<string> = new Set([
  "async",
  "await",
  "case",
  "catch",
  "class",
  "const",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
])

/** Punctuators that continue an expression onto the next line, so no semicolon is inserted before them. */
const continuing: ReadonlySet<string> = new Set([
  "(",
  "[",
  ".",
  "?.",
  ",",
  "?",
  ":",
  "=>",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "<<",
  ">>",
  ">>>",
  "&",
  "|",
  "^",
  "&&",
  "||",
  "??",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??="
])

const assignments: ReadonlySet<string> = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
  "++",
  "--"
])

/** Keywords that are operators, after which an operand comes. */
const operatorKeywords: ReadonlySet<string> = new Set(["in", "instanceof", "of", "typeof", "void", "case", "return"])

const classModifiers: ReadonlySet<string> = new Set(["async", "get", "set", "accessor"])

/** Splits a module into its top-level statements and finds what each one declares, uses, and does. */
export const analyze = (source: string, scan: Tokenizer.Scan): Analysis => {
  const { tokens } = scan
  const n = tokens.count
  const kinds = tokens.kinds
  const flags = tokens.flags
  const starts = tokens.starts
  const ends = tokens.ends

  const startOf = (i: number): number => starts[i] ?? source.length
  const endOf = (i: number): number => ends[i] ?? source.length
  const kindOf = (i: number): number => kinds[i] ?? 0
  const text = (i: number): string => source.slice(startOf(i), endOf(i))
  const is = (i: number, value: string): boolean => Tokenizer.is(source, tokens, i, value)
  const wordAt = (i: number): string | undefined => kindOf(i) === W ? text(i) : undefined
  const newlineBefore = (i: number): boolean => i < n && ((flags[i] ?? 0) & Tokenizer.NewlineBefore) !== 0
  const pureBefore = (i: number): boolean => ((flags[i] ?? 0) & Tokenizer.PureBefore) !== 0
  const importAt = new Map(scan.imports.map((entry, index) => [entry.start, index]))

  // Each bracket and template with its closing token
  const match = new Int32Array(n).fill(-1)
  {
    const open: Array<number> = []
    for (let i = 0; i < n; i++) {
      const kind = kindOf(i)
      if (kind === Tokenizer.Punctuator && endOf(i) - startOf(i) === 1) {
        const c = source.charCodeAt(startOf(i))
        if (c === 40 || c === 91 || c === 123) {
          open.push(i)
        } else if (c === 41 || c === 93 || c === 125) {
          const opener = open.pop()
          if (opener !== undefined) {
            match[opener] = i
            match[i] = opener
          }
        }
      } else if (kind === Tokenizer.TemplateHead) {
        open.push(i)
      } else if (kind === Tokenizer.TemplateTail) {
        const opener = open.pop()
        if (opener !== undefined) {
          match[opener] = i
          match[i] = opener
        }
      }
    }
  }

  const isOpener = (i: number): boolean =>
    kindOf(i) === Tokenizer.TemplateHead || (is(i, "(") || is(i, "[") || is(i, "{"))
  const isCloser = (i: number): boolean => is(i, ")") || is(i, "]") || is(i, "}")
  /** The index after an opener's closing token. */
  const after = (i: number): number => {
    const close = match[i] ?? -1
    return close === -1 ? n : close + 1
  }

  const canEnd = (i: number): boolean => {
    switch (kindOf(i)) {
      case W:
        return !nonEnding.has(text(i))
      case Tokenizer.Private:
      case Tokenizer.Number:
      case Tokenizer.String:
      case Tokenizer.Regex:
      case Tokenizer.Template:
      case Tokenizer.TemplateTail:
        return true
      case Tokenizer.Punctuator:
        return isCloser(i) || is(i, "++") || is(i, "--")
      default:
        return false
    }
  }

  const canContinue = (i: number): boolean => {
    switch (kindOf(i)) {
      case Tokenizer.Punctuator:
        return continuing.has(text(i))
      case Tokenizer.Template:
      case Tokenizer.TemplateHead:
        return true
      case W:
        return is(i, "in") || is(i, "instanceof")
      default:
        return false
    }
  }

  // Extents ------------------------------------------------------------------

  /** The end of a statement ended by a semicolon, or by a line break where one is inserted. */
  const expressionEnd = (from: number, to: number): number => {
    let i = from
    let previous = -1
    while (i < to) {
      if (is(i, ";")) return i + 1
      if (previous !== -1 && newlineBefore(i) && canEnd(previous) && !canContinue(i)) return i
      if (isCloser(i)) return i
      if (isOpener(i)) {
        previous = match[i] ?? -1
        i = after(i)
      } else {
        previous = i
        i++
      }
    }
    return to
  }

  const parensEnd = (i: number): number => is(i, "(") ? after(i) : i
  const blockEnd = (i: number): number => is(i, "{") ? after(i) : i

  /** From `function`: past its name, parameters and body. */
  const functionEnd = (i: number): number => {
    let j = i + 1
    if (is(j, "*")) j++
    if (kindOf(j) === W) j++
    return blockEnd(parensEnd(j))
  }

  /** From `class`: the body's opening brace, and where the extends clause starts if there is one. */
  const classParts = (i: number): { readonly heritage: number; readonly body: number } => {
    let j = i + 1
    if (kindOf(j) === W && !is(j, "extends")) j++
    const heritage = is(j, "extends") ? j + 1 : -1
    while (j < n && !is(j, "{")) j = isOpener(j) ? after(j) : j + 1
    return { heritage, body: j }
  }

  const statementEnd = (i: number): number => {
    if (i >= n) return n
    if (is(i, "{")) return after(i)
    if (is(i, ";")) return i + 1
    switch (wordAt(i)) {
      case "if": {
        let j = statementEnd(parensEnd(i + 1))
        if (is(j, "else")) j = statementEnd(j + 1)
        return j
      }
      case "for":
        return statementEnd(parensEnd(is(i + 1, "await") ? i + 2 : i + 1))
      case "while":
      case "with":
        return statementEnd(parensEnd(i + 1))
      case "do": {
        let j = statementEnd(i + 1)
        if (is(j, "while")) {
          j = parensEnd(j + 1)
          if (is(j, ";")) j++
        }
        return j
      }
      case "try": {
        let j = blockEnd(i + 1)
        if (is(j, "catch")) j = blockEnd(parensEnd(j + 1))
        if (is(j, "finally")) j = blockEnd(j + 1)
        return j
      }
      case "switch":
        return blockEnd(parensEnd(i + 1))
      case "function":
        return functionEnd(i)
      case "async":
        if (is(i + 1, "function") && !newlineBefore(i + 1)) return functionEnd(i + 1)
        break
      case "class":
        return after(classParts(i).body)
    }
    // A label
    if (kindOf(i) === W && is(i + 1, ":")) return statementEnd(i + 2)
    return expressionEnd(i, n)
  }

  // Purity -------------------------------------------------------------------

  /** From the first token after `=>`: past an arrow's body. */
  const arrowBodyEnd = (from: number, to: number): number => {
    if (is(from, "{")) return after(from)
    let i = from
    let questions = 0
    while (i < to) {
      if (isOpener(i)) {
        i = after(i)
        continue
      }
      if (isCloser(i) || is(i, ",") || is(i, ";")) return i
      if (is(i, "?")) {
        questions++
      } else if (is(i, ":")) {
        if (questions === 0) return i
        questions--
      }
      i++
    }
    return to
  }

  /** Past a call or `new` marked pure: its callee, then any member reads, calls and templates. */
  const pureCallEnd = (from: number): number => {
    let i = from
    while (is(i, "new")) i++
    // The callee: a function or class expression, as in an IIFE, or anything in brackets, or a name
    if (is(i, "function")) i = functionEnd(i)
    else if (is(i, "async") && is(i + 1, "function")) i = functionEnd(i + 1)
    else if (is(i, "class")) i = after(classParts(i).body)
    else i = isOpener(i) ? after(i) : i + 1
    for (;;) {
      if (is(i, ".") || is(i, "?.")) {
        i = isOpener(i + 1) ? after(i + 1) : i + 2
      } else if (is(i, "(") || is(i, "[") || kindOf(i) === Tokenizer.TemplateHead) {
        i = after(i)
      } else if (kindOf(i) === Tokenizer.Template) {
        i++
      } else {
        return i
      }
    }
  }

  /** Whether evaluating the tokens in a range could do anything: call, construct, assign, await. */
  const isPure = (from: number, to: number): boolean => {
    let i = from
    // Whether the previous token ends an operand, so that `(` calls and a template is tagged
    let operand = false
    while (i < to) {
      const kind = kindOf(i)
      if (pureBefore(i) && (kind === W || is(i, "("))) {
        i = pureCallEnd(i)
        operand = true
        continue
      }
      switch (kind) {
        case W: {
          const name = text(i)
          if (name === "function") {
            i = functionEnd(i)
          } else if (name === "async" && is(i + 1, "function")) {
            i = functionEnd(i + 1)
          } else if (name === "class") {
            const { end, pure } = classOf(i)
            if (!pure) return false
            i = end
          } else if (is(i + 1, "=>")) {
            i = arrowBodyEnd(i + 2, to)
          } else if (name === "async" && kindOf(i + 1) === W && is(i + 2, "=>")) {
            i = arrowBodyEnd(i + 3, to)
          } else if (name === "new" || name === "delete" || name === "await" || name === "yield") {
            return false
          } else if ((name === "import" || name === "super") && is(i + 1, "(")) {
            return false
          } else {
            operand = !operatorKeywords.has(name)
            i++
            continue
          }
          operand = true
          continue
        }
        case Tokenizer.Punctuator: {
          if (is(i, "(")) {
            const close = match[i] ?? -1
            if (close !== -1 && close + 1 < to && is(close + 1, "=>")) {
              // An arrow's parameters, or async's
              i = arrowBodyEnd(close + 2, to)
              operand = true
              continue
            }
            if (operand) {
              // A call, unless these are a method's parameters, as in `{ m() {} }`
              if (close === -1 || close + 1 >= to || !is(close + 1, "{")) return false
              i = after(close + 1)
              continue
            }
            operand = false
            i++
            continue
          }
          if (isCloser(i)) {
            operand = true
            i++
            continue
          }
          if (is(i, ".")) {
            i += 2
            operand = true
            continue
          }
          if (is(i, "?.")) {
            if (is(i + 1, "(")) return false
            if (is(i + 1, "[")) {
              i++
              operand = false
              continue
            }
            i += 2
            operand = true
            continue
          }
          if (is(i, "=>")) {
            i = arrowBodyEnd(i + 1, to)
            operand = true
            continue
          }
          if (assignments.has(text(i))) return false
          operand = false
          i++
          continue
        }
        case Tokenizer.Template:
        case Tokenizer.TemplateHead:
          // A tagged template is a call
          if (operand) return false
          operand = kind === Tokenizer.Template
          i++
          continue
        case Tokenizer.TemplateMiddle:
          operand = false
          i++
          continue
        case Tokenizer.TemplateTail:
        case Tokenizer.String:
        case Tokenizer.Number:
        case Tokenizer.Regex:
        case Tokenizer.Private:
          operand = true
          i++
          continue
        default:
          return false
      }
    }
    return true
  }

  /** Past the end of a class field: a semicolon, or a line break where one is inserted. */
  const fieldEnd = (from: number, to: number): number => {
    let i = from
    // The field's key
    let previous = from - 1
    while (i < to) {
      if (is(i, ";")) return i + 1
      if (previous !== -1 && newlineBefore(i) && canEnd(previous) && !canContinue(i)) return i
      if (isOpener(i)) {
        previous = match[i] ?? -1
        i = after(i)
      } else {
        previous = i
        i++
      }
    }
    return to
  }

  /**
   * Whether defining a class runs anything: its extends clause, computed
   * keys, static blocks and static field initializers. Methods and instance
   * fields run later.
   */
  const classOf = (i: number): { readonly end: number; readonly pure: boolean } => {
    const { body, heritage } = classParts(i)
    const end = after(body)
    if (!is(body, "{")) return { end, pure: false }
    if (heritage !== -1 && !isPure(heritage, body)) return { end, pure: false }
    const close = match[body] ?? n
    let j = body + 1
    while (j < close) {
      if (is(j, ";")) {
        j++
        continue
      }
      if (is(j, "@")) return { end, pure: false }
      const modifies = (k: number) => !(is(k + 1, "(") || is(k + 1, "=") || is(k + 1, ";") || k + 1 >= close)
      let isStatic = false
      if (is(j, "static") && modifies(j)) {
        if (is(j + 1, "{")) return { end, pure: false }
        isStatic = true
        j++
      }
      while (kindOf(j) === W && classModifiers.has(text(j)) && modifies(j) && !newlineBefore(j + 1)) j++
      if (is(j, "*")) j++
      if (is(j, "[")) {
        if (!isPure(j + 1, match[j] ?? close)) return { end, pure: false }
        j = after(j)
      } else {
        j++
      }
      if (is(j, "(")) {
        j = blockEnd(after(j))
        continue
      }
      const fieldClose = fieldEnd(j, close)
      if (isStatic && is(j, "=") && !isPure(j + 1, fieldClose)) return { end, pure: false }
      j = fieldClose
    }
    return { end, pure: true }
  }

  /** A binding pattern's names; destructuring an array iterates it, which may run anything. */
  const pattern = (i: number, names: Array<string>, to: number): { readonly end: number; readonly pure: boolean } => {
    if (kindOf(i) === W) {
      names.push(text(i))
      return { end: i + 1, pure: true }
    }
    if (!is(i, "{") && !is(i, "[")) return { end: i + 1, pure: false }
    const isArray = is(i, "[")
    const close = match[i] ?? to
    let pure = !isArray
    let j = i + 1
    while (j < close) {
      if (is(j, ",")) {
        j++
        continue
      }
      if (is(j, "...")) {
        const rest = pattern(j + 1, names, close)
        pure &&= rest.pure
        j = rest.end
        continue
      }
      if (isArray) {
        const element = pattern(j, names, close)
        pure &&= element.pure
        j = element.end
      } else {
        // A key, then `: target`, or a shorthand
        let key: string | undefined
        if (is(j, "[")) {
          pure &&= isPure(j + 1, match[j] ?? close)
          j = after(j)
        } else {
          key = wordAt(j)
          j++
        }
        if (is(j, ":")) {
          const target = pattern(j + 1, names, close)
          pure &&= target.pure
          j = target.end
        } else if (key !== undefined) {
          names.push(key)
        }
      }
      if (is(j, "=")) {
        let k = j + 1
        while (k < close && !is(k, ",")) k = isOpener(k) ? after(k) : k + 1
        pure &&= isPure(j + 1, k)
        j = k
      }
    }
    return { end: close + 1, pure }
  }

  /** `const a = 1, { b } = c`: the names, and whether every initializer is pure. */
  const declarators = (from: number, to: number, names: Array<string>): boolean => {
    let pure = true
    let i = from
    while (i < to) {
      const target = pattern(i, names, to)
      pure &&= target.pure
      i = target.end
      if (is(i, "=")) {
        let j = i + 1
        while (j < to && !is(j, ",") && !is(j, ";")) j = isOpener(j) ? after(j) : j + 1
        pure &&= isPure(i + 1, j)
        i = j
      }
      if (!is(i, ",")) break
      i++
    }
    return pure
  }

  // Imports and exports ------------------------------------------------------

  const nameAt = (i: number): Name => {
    const raw = text(i)
    return { raw, name: kindOf(i) === Tokenizer.String ? Tokenizer.decode(raw.slice(1, -1)) : raw }
  }

  /** `{ a, b as c, "d" as e }` from its opening brace. */
  const specifierList = (open: number): Array<Specifier> => {
    const close = match[open] ?? n
    const list: Array<Specifier> = []
    let i = open + 1
    while (i < close) {
      if (is(i, ",")) {
        i++
        continue
      }
      const from = nameAt(i)
      if (is(i + 1, "as")) {
        list.push({ from, to: nameAt(i + 2) })
        i += 3
      } else {
        list.push({ from, to: from })
        i++
      }
    }
    return list
  }

  /** The specifier string at or after a token, as its index in Scan.imports. */
  const sourceFrom = (from: number, to: number): number => {
    for (let i = from; i < to; i++) {
      if (kindOf(i) === Tokenizer.String) {
        const index = importAt.get(startOf(i))
        if (index !== undefined) return index
      }
    }
    return -1
  }

  // Statements ---------------------------------------------------------------

  interface Draft {
    kind: Kind
    first: number
    last: number
    pure: boolean
    declares: Array<string>
    source: number
    defaultBinding: string | undefined
    namespaceBinding: string | undefined
    specifiers: Array<Specifier>
    namespaceExport: Name | undefined
  }

  const drafts: Array<Draft> = []
  const bindings = new Map<string, Binding>()
  const exports = new Map<string, Export>()
  const reexports = new Map<string, Binding>()
  const stars: Array<number> = []

  const draft = (kind: Kind, first: number, last: number, pure: boolean): Draft => {
    const statement: Draft = {
      kind,
      first,
      last,
      pure,
      declares: [],
      source: -1,
      defaultBinding: undefined,
      namespaceBinding: undefined,
      specifiers: [],
      namespaceExport: undefined
    }
    drafts.push(statement)
    return statement
  }

  /** A declaration after `export` or at the top level: variables, a function or a class; undefined otherwise. */
  const declarationAt = (i: number, first: number): Draft | undefined => {
    const name = wordAt(i)
    if (name === "const" || name === "let" || name === "var") {
      const last = expressionEnd(i, n)
      const names: Array<string> = []
      const statement = draft("variable", first, last, declarators(i + 1, last, names))
      statement.declares.push(...names)
      return statement
    }
    const isAsync = name === "async" && is(i + 1, "function") && !newlineBefore(i + 1)
    if (name === "function" || isAsync) {
      const keyword = isAsync ? i + 1 : i
      const statement = draft("function", first, functionEnd(keyword), true)
      const nameIndex = is(keyword + 1, "*") ? keyword + 2 : keyword + 1
      if (kindOf(nameIndex) === W) statement.declares.push(text(nameIndex))
      return statement
    }
    if (name === "class") {
      const { end, pure } = classOf(i)
      const statement = draft("class", first, end, pure)
      if (kindOf(i + 1) === W && !is(i + 1, "extends")) statement.declares.push(text(i + 1))
      return statement
    }
    return undefined
  }

  let i = 0
  while (i < n) {
    const first = i
    const name = wordAt(i)
    if (name === "import" && !is(i + 1, "(") && !is(i + 1, ".")) {
      const last = expressionEnd(i, n)
      const statement = draft("import", first, last, true)
      statement.source = sourceFrom(i + 1, last)
      let j = i + 1
      if ((is(j, "defer") && is(j + 1, "*")) || (is(j, "source") && kindOf(j + 1) === W && !is(j + 1, "from"))) j++
      if (kindOf(j) === W && !is(j, "from")) {
        statement.defaultBinding = text(j)
        j++
        if (is(j, ",")) j++
      } else if (kindOf(j) === W && is(j + 1, "from") && kindOf(j + 2) === Tokenizer.String) {
        // `import from from "x"`
        statement.defaultBinding = text(j)
        j++
      }
      if (is(j, "*") && is(j + 1, "as")) {
        statement.namespaceBinding = text(j + 2)
        j += 3
      }
      if (is(j, "{")) statement.specifiers.push(...specifierList(j))
      if (statement.source !== -1) {
        if (statement.defaultBinding !== undefined) {
          bindings.set(statement.defaultBinding, { imported: "default", source: statement.source })
        }
        if (statement.namespaceBinding !== undefined) {
          bindings.set(statement.namespaceBinding, { imported: "*", source: statement.source })
        }
        for (const { from, to } of statement.specifiers) {
          bindings.set(to.name, { imported: from.name, source: statement.source })
        }
      }
      i = last
      continue
    }

    if (name === "export") {
      const next = i + 1
      if (is(next, "*")) {
        const last = expressionEnd(i, n)
        const source = sourceFrom(next, last)
        if (is(next + 1, "as")) {
          const statement = draft("exportFrom", first, last, true)
          statement.source = source
          statement.namespaceExport = nameAt(next + 2)
          if (source !== -1) reexports.set(statement.namespaceExport.name, { imported: "*", source })
        } else {
          const statement = draft("exportStar", first, last, true)
          statement.source = source
          if (source !== -1) stars.push(source)
        }
        i = last
        continue
      }
      if (is(next, "{")) {
        const last = expressionEnd(i, n)
        const specifiers = specifierList(next)
        if (is(after(next), "from")) {
          const statement = draft("exportFrom", first, last, true)
          statement.source = sourceFrom(after(next), last)
          statement.specifiers.push(...specifiers)
          if (statement.source !== -1) {
            for (const { from, to } of specifiers) {
              reexports.set(to.name, { imported: from.name, source: statement.source })
            }
          }
        } else {
          const statement = draft("exportList", first, last, true)
          statement.specifiers.push(...specifiers)
          for (const { from, to } of specifiers) exports.set(to.name, { _tag: "Local", local: from.name })
        }
        i = last
        continue
      }
      if (is(next, "default")) {
        const declaration = declarationAt(next + 1, first)
        if (declaration !== undefined && declaration.kind !== "variable") {
          const local = declaration.declares[0]
          exports.set(
            "default",
            local === undefined
              ? { _tag: "Statement", statement: drafts.length - 1 }
              : { _tag: "Local", local }
          )
          i = declaration.last
          continue
        }
        if (declaration !== undefined) drafts.pop()
        const last = expressionEnd(next + 1, n)
        draft("exportDefault", first, last, isPure(next + 1, last))
        exports.set("default", { _tag: "Statement", statement: drafts.length - 1 })
        i = last
        continue
      }
      const declaration = declarationAt(next, first)
      if (declaration !== undefined) {
        for (const local of declaration.declares) exports.set(local, { _tag: "Local", local })
        i = declaration.last
        continue
      }
    }

    const declaration = name === undefined ? undefined : declarationAt(i, first)
    if (declaration !== undefined) {
      i = declaration.last
      continue
    }
    const last = Math.max(statementEnd(i), i + 1)
    draft("other", first, last, false)
    i = last
  }

  // Declarations and references ----------------------------------------------

  const declarations = new Map<string, Array<number>>()
  drafts.forEach((statement, index) => {
    for (const local of statement.declares) {
      const list = declarations.get(local)
      if (list === undefined) declarations.set(local, [index])
      else list.push(index)
    }
  })

  const moduleNames = new Set([...bindings.keys(), ...declarations.keys()])

  const statements = drafts.map((statement): Statement => {
    const references = new Set<string>()
    const namespaces = new Map<string, Set<string> | "escape">()
    const uses = statement.kind === "variable" || statement.kind === "function" || statement.kind === "class" ||
      statement.kind === "exportDefault" || statement.kind === "other"
    if (uses) {
      for (let t = statement.first; t < statement.last; t++) {
        if (kindOf(t) !== W) continue
        if (is(t - 1, ".") || is(t - 1, "?.")) continue
        const name = text(t)
        if (!moduleNames.has(name)) continue
        // An object's key, `{ a: 1 }`, names nothing
        if (is(t + 1, ":") && (is(t - 1, "{") || is(t - 1, ","))) continue
        references.add(name)
        if (bindings.get(name)?.imported !== "*") continue
        let member: string | undefined
        if ((is(t + 1, ".") || is(t + 1, "?.")) && kindOf(t + 2) === W) {
          member = text(t + 2)
        } else {
          const open = is(t + 1, "[") ? t + 1 : is(t + 1, "?.") && is(t + 2, "[") ? t + 2 : -1
          if (open !== -1 && kindOf(open + 1) === Tokenizer.String && is(open + 2, "]")) member = nameAt(open + 1).name
        }
        const used = namespaces.get(name)
        if (member === undefined) namespaces.set(name, "escape")
        else if (used === undefined) namespaces.set(name, new Set([member]))
        else if (used !== "escape") used.add(member)
      }
    }
    return {
      kind: statement.kind,
      start: startOf(statement.first),
      end: endOf(statement.last - 1),
      pure: statement.pure,
      declares: statement.declares,
      references: [...references],
      namespaces,
      source: statement.source,
      defaultBinding: statement.defaultBinding,
      namespaceBinding: statement.namespaceBinding,
      specifiers: statement.specifiers,
      namespaceExport: statement.namespaceExport
    }
  })

  // The statement holding each literal import()
  const dynamic = new Map<number, number>()
  scan.imports.forEach((entry, index) => {
    if (entry.kind !== "dynamic") return
    let low = 0
    let high = statements.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const statement = statements[middle]!
      if (entry.start < statement.start) high = middle - 1
      else if (entry.start >= statement.end) low = middle + 1
      else {
        dynamic.set(index, middle)
        return
      }
    }
  })

  return { statements, bindings, declarations, exports, reexports, stars, dynamic }
}

// Marking ----------------------------------------------------------------------

export interface Module {
  readonly analysis: Analysis
  /** The module each import leads to, by its index in Scan.imports; undefined when it can't be resolved or read. */
  readonly targets: ReadonlyArray<number | undefined>
  /** Whether merely importing it does something, from its package's "sideEffects". */
  readonly sideEffects: boolean
  readonly entry: boolean
}

export interface Marks {
  /** Whether each module is kept. */
  readonly included: Uint8Array
  /** For each module, whether each statement is kept. */
  readonly live: ReadonlyArray<Uint8Array>
  /** For each module, the export names needed, or "all". */
  readonly needed: ReadonlyArray<ReadonlySet<string> | "all">
  /** For each module, the import bindings still used. */
  readonly used: ReadonlyArray<ReadonlySet<string>>
  /** Imports of kept modules that can't be resolved or read, by module and index in Scan.imports, in order. */
  readonly broken: ReadonlyArray<{ readonly module: number; readonly source: number }>
}

type Task =
  | { readonly _tag: "Include"; readonly module: number }
  | { readonly _tag: "Statement"; readonly module: number; readonly statement: number }
  | { readonly _tag: "Export"; readonly module: number; readonly name: string }
  | { readonly _tag: "All"; readonly module: number }
  | { readonly _tag: "Binding"; readonly module: number; readonly name: string }

const isBare = (statement: Statement): boolean =>
  statement.defaultBinding === undefined && statement.namespaceBinding === undefined && statement.specifiers.length === 0

const runs = (kind: Kind): boolean =>
  kind === "variable" || kind === "function" || kind === "class" || kind === "exportDefault" || kind === "other"

/**
 * Marks, to a fixed point, the statements and exports the entries reach.
 * Entries keep everything; a kept module keeps its statements that aren't
 * pure; a statement keeps what it uses; and an import of a module with side
 * effects keeps that module.
 */
export const mark = (modules: ReadonlyArray<Module>): Marks => {
  const included = new Uint8Array(modules.length)
  const live = modules.map((module) => new Uint8Array(module.analysis.statements.length))
  const needed = modules.map(() => new Set<string>())
  const all = new Uint8Array(modules.length)
  const used = modules.map(() => new Set<string>())
  const broken: Array<{ readonly module: number; readonly source: number }> = []
  const brokenSeen = new Set<string>()
  const queue: Array<Task> = []

  const target = (module: number, source: number): number | undefined => {
    const index = modules[module]!.targets[source]
    if (index === undefined) {
      const key = `${module}:${source}`
      if (!brokenSeen.has(key)) {
        brokenSeen.add(key)
        broken.push({ module, source })
      }
    }
    return index
  }

  /** Whether a module exports a name, itself or through `export *`. */
  const provides = (module: number, name: string, visiting: Set<number>): boolean => {
    const { analysis, targets } = modules[module]!
    if (analysis.exports.has(name) || analysis.reexports.has(name)) return true
    for (const source of analysis.stars) {
      const next = targets[source]
      if (next === undefined || visiting.has(next)) continue
      visiting.add(next)
      if (provides(next, name, visiting)) return true
    }
    return false
  }

  const useBinding = (module: number, name: string, binding: Binding, members: ReadonlySet<string> | "escape") => {
    used[module]!.add(name)
    const next = target(module, binding.source)
    if (next === undefined) return
    if (binding.imported !== "*") queue.push({ _tag: "Export", module: next, name: binding.imported })
    else if (members === "escape") queue.push({ _tag: "All", module: next })
    else for (const member of members) queue.push({ _tag: "Export", module: next, name: member })
  }

  const run = (task: Task): void => {
    const module = modules[task.module]!
    const { analysis } = module
    switch (task._tag) {
      case "Include": {
        if (included[task.module] === 1) return
        included[task.module] = 1
        analysis.statements.forEach((statement, index) => {
          if (runs(statement.kind) && !statement.pure) {
            queue.push({ _tag: "Statement", module: task.module, statement: index })
          }
          if (statement.kind === "import" || statement.kind === "exportFrom" || statement.kind === "exportStar") {
            if (statement.source === -1) return
            const next = module.targets[statement.source]
            if (next !== undefined) {
              if (modules[next]!.sideEffects) queue.push({ _tag: "Include", module: next })
            } else if (statement.kind === "import" && isBare(statement)) {
              // Imported only to run it, so it must be bundled; with bindings, only if one is used
              target(task.module, statement.source)
            }
          }
        })
        return
      }
      case "Statement": {
        const marks = live[task.module]!
        if (marks[task.statement] === 1) return
        marks[task.statement] = 1
        queue.push({ _tag: "Include", module: task.module })
        const statement = analysis.statements[task.statement]!
        for (const name of statement.references) {
          const binding = analysis.bindings.get(name)
          if (binding === undefined) {
            for (const declaring of analysis.declarations.get(name) ?? []) {
              queue.push({ _tag: "Statement", module: task.module, statement: declaring })
            }
          } else {
            useBinding(task.module, name, binding, statement.namespaces.get(name) ?? "escape")
          }
        }
        for (const [source, holder] of analysis.dynamic) {
          if (holder !== task.statement) continue
          const next = target(task.module, source)
          if (next !== undefined) queue.push({ _tag: "All", module: next })
        }
        return
      }
      case "Binding": {
        const binding = analysis.bindings.get(task.name)
        if (binding !== undefined) {
          // An import exported again, as in `import { a } from "x"; export { a }`
          useBinding(task.module, task.name, binding, "escape")
          return
        }
        for (const declaring of analysis.declarations.get(task.name) ?? []) {
          queue.push({ _tag: "Statement", module: task.module, statement: declaring })
        }
        return
      }
      case "Export": {
        const names = needed[task.module]!
        if (names.has(task.name)) return
        names.add(task.name)
        queue.push({ _tag: "Include", module: task.module })
        const local = analysis.exports.get(task.name)
        if (local !== undefined) {
          queue.push(
            local._tag === "Statement"
              ? { _tag: "Statement", module: task.module, statement: local.statement }
              : { _tag: "Binding", module: task.module, name: local.local }
          )
          return
        }
        const reexport = analysis.reexports.get(task.name)
        if (reexport !== undefined) {
          const next = target(task.module, reexport.source)
          if (next === undefined) return
          queue.push(
            reexport.imported === "*"
              ? { _tag: "All", module: next }
              : { _tag: "Export", module: next, name: reexport.imported }
          )
          return
        }
        if (task.name === "default") return
        for (const source of analysis.stars) {
          // A star that can't be resolved might provide the name
          const next = target(task.module, source)
          if (next !== undefined && provides(next, task.name, new Set([task.module, next]))) {
            queue.push({ _tag: "Export", module: next, name: task.name })
            return
          }
        }
        return
      }
      case "All": {
        if (all[task.module] === 1) return
        all[task.module] = 1
        queue.push({ _tag: "Include", module: task.module })
        for (const name of [...analysis.exports.keys(), ...analysis.reexports.keys()]) {
          queue.push({ _tag: "Export", module: task.module, name })
        }
        for (const source of analysis.stars) {
          const next = target(task.module, source)
          if (next !== undefined) queue.push({ _tag: "All", module: next })
        }
        return
      }
    }
  }

  modules.forEach((module, index) => {
    if (!module.entry) return
    queue.push({ _tag: "All", module: index })
    module.analysis.statements.forEach((_, statement) => queue.push({ _tag: "Statement", module: index, statement }))
  })
  for (let next = 0; next < queue.length; next++) {
    run(queue[next]!)
    // Keep the queue from growing without bound on large graphs
    if (next > 65536) {
      queue.splice(0, next + 1)
      next = -1
    }
  }

  return {
    included,
    live,
    needed: needed.map((names, index) => all[index] === 1 ? "all" : names),
    used,
    broken
  }
}

// Rendering --------------------------------------------------------------------

/** Text in place of a range: strings, and import indexes where each specifier's literal goes. */
export interface Replacement {
  readonly start: number
  readonly end: number
  readonly parts: ReadonlyArray<string | number>
}

export interface Rendering {
  readonly replacements: ReadonlyArray<Replacement>
  /** The imports that stay, by their index in Scan.imports, in order. */
  readonly kept: ReadonlyArray<number>
}

/**
 * What to change in a kept module: dropped statements become a semicolon and
 * their line breaks, so that line numbers and statement boundaries hold, and
 * import and export lists lose the names nothing uses.
 */
export const render = (
  source: string,
  module: Module,
  marks: Marks,
  index: number,
  /** Whether a module is kept and merely importing it does something. */
  keepsSideEffects: (module: number) => boolean
): Rendering => {
  const { analysis, targets } = module
  const live = marks.live[index]!
  const needed = marks.needed[index]!
  const used = marks.used[index]!
  const replacements: Array<Replacement> = []
  const kept: Array<number> = []

  const isNeeded = (name: string) => needed === "all" || needed.has(name)
  const lineBreaks = (statement: Statement) => "\n".repeat(Tokenizer.lines(source, statement.start, statement.end))
  const drop = (statement: Statement) =>
    replacements.push({ start: statement.start, end: statement.end, parts: [`;${lineBreaks(statement)}`] })
  const replace = (statement: Statement, parts: Array<string | number>) =>
    replacements.push({ start: statement.start, end: statement.end, parts: [...parts, `;${lineBreaks(statement)}`] })
  const list = (specifiers: ReadonlyArray<Specifier>) =>
    `{ ${specifiers.map(({ from, to }) => from.raw === to.raw ? from.raw : `${from.raw} as ${to.raw}`).join(", ")} }`
  /** Nothing used, but the module still runs: `import "x"`. */
  const sideEffectsOnly = (statement: Statement) => {
    const next = targets[statement.source]
    if (next !== undefined && keepsSideEffects(next)) {
      replace(statement, ["import ", statement.source])
      kept.push(statement.source)
    } else {
      drop(statement)
    }
  }

  analysis.statements.forEach((statement, at) => {
    const imports = statement.kind === "import" || statement.kind === "exportFrom" || statement.kind === "exportStar"
    // A specifier the tokenizer didn't find stays as it is
    if (imports && statement.source === -1) return
    switch (statement.kind) {
      case "import": {
        const hasBindings = !isBare(statement)
        const keepDefault = statement.defaultBinding !== undefined && used.has(statement.defaultBinding)
        const keepNamespace = statement.namespaceBinding !== undefined && used.has(statement.namespaceBinding)
        const named = statement.specifiers.filter(({ to }) => used.has(to.name))
        if (!keepDefault && !keepNamespace && named.length === 0) {
          if (hasBindings) sideEffectsOnly(statement)
          else if (marks.included[targets[statement.source] ?? -1] === 1) kept.push(statement.source)
          else drop(statement)
          return
        }
        kept.push(statement.source)
        const unchanged = (keepDefault || statement.defaultBinding === undefined) &&
          (keepNamespace || statement.namespaceBinding === undefined) &&
          named.length === statement.specifiers.length
        if (unchanged) return
        const clause: Array<string> = []
        if (keepDefault) clause.push(statement.defaultBinding!)
        if (keepNamespace) clause.push(`* as ${statement.namespaceBinding}`)
        if (named.length > 0) clause.push(list(named))
        replace(statement, [`import ${clause.join(", ")} from `, statement.source])
        return
      }
      case "exportFrom": {
        if (statement.namespaceExport !== undefined) {
          if (isNeeded(statement.namespaceExport.name)) kept.push(statement.source)
          else sideEffectsOnly(statement)
          return
        }
        const names = statement.specifiers.filter(({ to }) => isNeeded(to.name))
        if (names.length === 0) {
          sideEffectsOnly(statement)
          return
        }
        kept.push(statement.source)
        if (names.length < statement.specifiers.length) replace(statement, [`export ${list(names)} from `, statement.source])
        return
      }
      case "exportStar": {
        const next = targets[statement.source]
        if (next !== undefined && marks.included[next] === 1) kept.push(statement.source)
        else drop(statement)
        return
      }
      case "exportList": {
        const names = statement.specifiers.filter(({ to }) => isNeeded(to.name))
        if (names.length === 0) drop(statement)
        else if (names.length < statement.specifiers.length) replace(statement, [`export ${list(names)}`])
        return
      }
      default: {
        if (live[at] !== 1) {
          drop(statement)
          return
        }
        for (const [source, holder] of analysis.dynamic) if (holder === at) kept.push(source)
      }
    }
  })

  kept.sort((a, b) => a - b)
  return { replacements, kept }
}
