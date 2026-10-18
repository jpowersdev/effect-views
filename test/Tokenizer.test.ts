import * as Vitest from "vitest"

import * as Tokenizer from "../src/internal/Tokenizer.js"

const specifiers = (source: string) => Tokenizer.scan(source).imports.map((entry) => entry.specifier)

const comments = (source: string) =>
  Tokenizer.scan(source).comments.map(({ end, start }) => source.slice(start, end))

const failure = (source: string): Tokenizer.TokenizerError => {
  try {
    Tokenizer.scan(source)
  } catch (error) {
    if (error instanceof Tokenizer.TokenizerError) return error
    throw error
  }
  throw new Error(`Expected ${JSON.stringify(source)} not to tokenize`)
}

Vitest.describe("Tokenizer", () => {
  Vitest.it("tells comments from strings", () => {
    const source = [
      `const a = "// not a comment", b = '/* nor this */'; // a "comment"`,
      `/* 'also' a comment */ import "./x.js" /* "./y.js" */`,
      `const c = "\\" // still a string"`
    ].join("\n")
    Vitest.expect(comments(source)).toEqual([`// a "comment"`, `/* 'also' a comment */`, `/* "./y.js" */`])
    Vitest.expect(specifiers(source)).toEqual(["./x.js"])
  })

  Vitest.it("reads regular expressions with quotes, slashes in classes, and escapes", () => {
    const source = [
      "const quotes = /['\"`]/g",
      "const slashes = /[/]+/",
      "const escaped = /a\\/b\\/*c/",
      "const star = /x*/ // a comment",
      "import \"./x.js\""
    ].join("\n")
    Vitest.expect(comments(source)).toEqual(["// a comment"])
    Vitest.expect(specifiers(source)).toEqual(["./x.js"])
  })

  // Each line divides, then has a string with a slash: read as a regular
  // expression, the slash would end it and leave the string's quote unclosed
  Vitest.it.each([
    "a = b / c / d; e = '/'",
    "a = (b) / 2; e = '/'",
    "a = b[0] / 2; e = '/'",
    "a = b.c / 2; e = '/'",
    "a = x.return / 2; e = '/'",
    "a = x?.typeof / 2; e = '/'",
    "a = 1 / 2; e = '/'",
    "a = 1_000 / 2 / 0x1F / 1n / .5 / 1e3 / 1.5e-3; e = '/'",
    "a = 1..toString() / 2; e = '/'",
    "a = 'x' / 2; e = '/'",
    "a = `x` / 2; e = '/'",
    "a = `${b}` / 2; e = '/'",
    "a = f(b) / 2; e = '/'",
    "a = b++ / 2; e = '/'",
    "a = b-- / 2; e = '/'",
    "a = {} / 2; e = '/'",
    "a = this / 2; e = '/'",
    "a = $ / _ / café / π; e = '/'",
    "class A { #x = 1; m() { return this.#x / 2 } }; e = '/'",
    "a = /re/ / 2; e = '/'"
  ])("divides in %s", (source) => {
    Vitest.expect(specifiers(`${source}; import "./x.js"`)).toEqual(["./x.js"])
  })

  // Each line has a regular expression with a quote: read as a division, the
  // quote would start a string that never closes
  Vitest.it.each([
    "x = /'/",
    "f(/'/)",
    "[/'/]",
    "a = b ? /'/ : /\"/",
    "function f() { return /'/.test(s) }",
    "if (ok) /'/.test(s)",
    "while (ok) /'/.test(s)",
    "for (;;) /'/.test(s)",
    "async () => { for await (const x of y) /'/.test(x) }",
    "a = typeof /'/",
    "a = b in /'/",
    "a = b instanceof /'/",
    "throw /'/",
    "a = !/'/.test(s)",
    "export default /'/",
    "switch (x) { case /'/: break; default: /'/ }",
    "a = `${/'/.source}`",
    "if (ok) {}\n/'/.test(s)",
    "{}\n/'/.test(s)",
    "/'/.test(s)"
  ])("reads a regular expression in %s", (source) => {
    Vitest.expect(specifiers(`${source}; import "./x.js"`)).toEqual(["./x.js"])
  })

  Vitest.it("reads templates with nested templates, braces and strings", () => {
    const source = [
      "const t = `a ${ `b ${ \"}\" } c` } // not a comment ${ { a: 1 }.a } ${ '`' } \\` ${ `${ `` }` }`",
      "const u = `import \"./no.js\" ${ import(\"./yes.js\") }`",
      "import \"./x.js\""
    ].join("\n")
    Vitest.expect(comments(source)).toEqual([])
    Vitest.expect(specifiers(source)).toEqual(["./yes.js", "./x.js"])
  })

  Vitest.it("finds every form of static import", () => {
    const source = [
      `import x from "./a.js"`,
      `import { a, b as c } from "./b.js"`,
      `import * as ns from "./c.js"`,
      `import x2, { y } from './d.js'`,
      `import "./e.js"`,
      `import x3, * as ns2 from "./f.js"`,
      `import {`,
      `  a2, // the first`,
      `  "b-2" as b2 /* the second */`,
      `} from`,
      `  "./g.js"`,
      `import{h}from"./h.js"`,
      `import "./a\\u002ejs"`
    ].join("\n")
    const { imports } = Tokenizer.scan(source)
    Vitest.expect(imports.map((entry) => entry.specifier)).toEqual([
      "./a.js",
      "./b.js",
      "./c.js",
      "./d.js",
      "./e.js",
      "./f.js",
      "./g.js",
      "./h.js",
      "./a.js"
    ])
    Vitest.expect(imports.every((entry) => entry.kind === "static" && !entry.attributes)).toBe(true)
    Vitest.expect(imports.map((entry) => source.slice(entry.start, entry.end))).toContain(`'./d.js'`)
    Vitest.expect(imports[3]?.quote).toBe("'")
  })

  Vitest.it("finds re-exports, and nothing in other exports", () => {
    const source = [
      `export * from "./a.js"`,
      `export * as ns from "./b.js"`,
      `export { a, b as default } from "./c.js"`,
      `export { "x-y" as z } from "./d.js"`,
      `export * as "s" from "./e.js"`,
      `export { e }`,
      `import f from "./f.js"`,
      `export const g = "./no.js"`,
      `export default "./no.js"`,
      `export function h() { return "./no.js" }`,
      `export {}`
    ].join("\n")
    Vitest.expect(specifiers(source)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js"])
  })

  Vitest.it("finds import() with a literal and leaves other arguments alone", () => {
    const source = [
      `import("./a.js")`,
      `import('./b.js').then(f)`,
      "await import(`./c.js`)",
      `import ( /* where */ "./d.js" , )`,
      `import(name)`,
      `import("./" + name)`,
      "import(`./${name}.js`)"
    ].join("\n")
    const { imports } = Tokenizer.scan(source)
    Vitest.expect(imports.map((entry) => [entry.kind, entry.specifier, entry.quote])).toEqual([
      ["dynamic", "./a.js", "\""],
      ["dynamic", "./b.js", "'"],
      ["dynamic", "./c.js", "`"],
      ["dynamic", "./d.js", "\""]
    ])
    Vitest.expect(imports.map((entry) => source.slice(entry.start, entry.end))).toEqual([
      `"./a.js"`,
      `'./b.js'`,
      "`./c.js`",
      `"./d.js"`
    ])
  })

  Vitest.it("ignores import and export as property names, and import.meta", () => {
    const source = [
      `x.import("./no.js")`,
      `x?.import("./no.js")`,
      `x\n  .import("./no.js")`,
      `const o = { import: "./no.js", export: "./no.js" }`,
      `class A { import() { return "./no.js" } static export = "./no.js"; #import = "./no.js" }`,
      `const url = import.meta.url`,
      `const dir = import.meta.dirname + "./no.js"`
    ].join("\n")
    Vitest.expect(specifiers(source)).toEqual([])
  })

  Vitest.it("marks import attributes", () => {
    const { imports } = Tokenizer.scan([
      `import data from "./data.json" with { type: "json" }`,
      `import old from "./old.json" assert { type: "json" }`,
      `const lazy = import("./lazy.json", { with: { type: "json" } })`,
      `import "./plain.js"`,
      `assert(ok)`
    ].join("\n"))
    Vitest.expect(imports.map((entry) => [entry.specifier, entry.attributes])).toEqual([
      ["./data.json", true],
      ["./old.json", true],
      ["./lazy.json", true],
      ["./plain.js", false]
    ])
  })

  Vitest.it("reads a hashbang as a comment", () => {
    const source = "#!/usr/bin/env node\nimport \"./a.js\""
    Vitest.expect(comments(source)).toEqual(["#!/usr/bin/env node"])
    Vitest.expect(specifiers(source)).toEqual(["./a.js"])
  })

  Vitest.it("reports what doesn't end, with its line and column", () => {
    Vitest.expect(failure("const a = 1\nconst s = \"abc")).toMatchObject({
      message: "Unterminated string literal",
      line: 2,
      column: 11
    })
    Vitest.expect(failure("const s = 'abc\ndef'")).toMatchObject({ message: "Unterminated string literal", line: 1, column: 11 })
    Vitest.expect(failure("a\r\nb = `abc ${ x")).toMatchObject({ message: "Unterminated template literal", line: 2, column: 5 })
    Vitest.expect(failure("x = `a ${ `b` ")).toMatchObject({ message: "Unterminated template literal", line: 1, column: 5 })
    Vitest.expect(failure("x = `a")).toMatchObject({ message: "Unterminated template literal", line: 1, column: 5 })
    Vitest.expect(failure("x\n  /* abc")).toMatchObject({ message: "Unterminated comment", line: 2, column: 3 })
    Vitest.expect(failure("x = /abc\n/")).toMatchObject({ message: "Unterminated regular expression", line: 1, column: 5 })
    Vitest.expect(failure("x = /[/]")).toMatchObject({ message: "Unterminated regular expression", line: 1, column: 5 })
  })
})

Vitest.describe("Tokenizer tokens", () => {
  const kindNames: Readonly<Record<number, string>> = {
    [Tokenizer.Word]: "word",
    [Tokenizer.Private]: "private",
    [Tokenizer.Punctuator]: "punctuator",
    [Tokenizer.String]: "string",
    [Tokenizer.Number]: "number",
    [Tokenizer.Regex]: "regex",
    [Tokenizer.Template]: "template",
    [Tokenizer.TemplateHead]: "head",
    [Tokenizer.TemplateMiddle]: "middle",
    [Tokenizer.TemplateTail]: "tail",
    [Tokenizer.JsxTagStart]: "<",
    [Tokenizer.JsxClosingTagStart]: "</",
    [Tokenizer.JsxTagEnd]: ">",
    [Tokenizer.JsxSelfClosing]: "/>",
    [Tokenizer.JsxName]: "name",
    [Tokenizer.JsxString]: "attribute",
    [Tokenizer.JsxText]: "text",
    [Tokenizer.JsxExpressionStart]: "{",
    [Tokenizer.JsxExpressionEnd]: "}"
  }

  const tokens = (source: string, options?: Tokenizer.Options) => {
    const { tokens } = Tokenizer.scan(source, options)
    return Array.from({ length: tokens.count }, (_, i) => [kindNames[tokens.kinds[i]!], Tokenizer.text(source, tokens, i)])
  }

  Vitest.it("reads every token, with punctuators whole", () => {
    Vitest.expect(tokens("x.#y >>>= /re/g.test(`a${b}c${`d`}e`) ?? 1_000n ?.5 : a?.b // c")).toEqual([
      ["word", "x"],
      ["punctuator", "."],
      ["private", "#y"],
      ["punctuator", ">>>="],
      ["regex", "/re/g"],
      ["punctuator", "."],
      ["word", "test"],
      ["punctuator", "("],
      ["head", "`a${"],
      ["word", "b"],
      ["middle", "}c${"],
      ["template", "`d`"],
      ["tail", "}e`"],
      ["punctuator", ")"],
      ["punctuator", "??"],
      ["number", "1_000n"],
      ["punctuator", "?"],
      ["number", ".5"],
      ["punctuator", ":"],
      ["word", "a"],
      ["punctuator", "?."],
      ["word", "b"]
    ])
  })

  Vitest.it("marks line breaks and pure annotations before tokens", () => {
    const source = "a /* one\n */ b\nc /*#__PURE__*/ d /* @__PURE__ */ new e"
    const { tokens: scanned } = Tokenizer.scan(source)
    const flags = Array.from(scanned.flags)
    Vitest.expect(flags).toEqual([
      0,
      Tokenizer.NewlineBefore,
      Tokenizer.NewlineBefore,
      Tokenizer.PureBefore,
      Tokenizer.PureBefore,
      0
    ])
  })

  Vitest.it("reads JSX where an expression can start, with the expressions inside as JavaScript", () => {
    Vitest.expect(tokens(`x = <a.b c="d" {...e} f:g>h {i < j}<k /></a.b>`, { jsx: true })).toEqual([
      ["word", "x"],
      ["punctuator", "="],
      ["<", "<"],
      ["name", "a"],
      ["punctuator", "."],
      ["name", "b"],
      ["name", "c"],
      ["punctuator", "="],
      ["attribute", `"d"`],
      ["{", "{"],
      ["punctuator", "..."],
      ["word", "e"],
      ["}", "}"],
      ["name", "f"],
      ["punctuator", ":"],
      ["name", "g"],
      [">", ">"],
      ["text", "h "],
      ["{", "{"],
      ["word", "i"],
      ["punctuator", "<"],
      ["word", "j"],
      ["}", "}"],
      ["<", "<"],
      ["name", "k"],
      ["/>", "/>"],
      ["</", "</"],
      ["name", "a"],
      ["punctuator", "."],
      ["name", "b"],
      [">", ">"]
    ])
    // Without the option, or after an operand, `<` compares
    Vitest.expect(tokens(`a <b> c`, { jsx: true })).toEqual([
      ["word", "a"],
      ["punctuator", "<"],
      ["word", "b"],
      ["punctuator", ">"],
      ["word", "c"]
    ])
  })
})
