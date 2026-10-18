import * as Vitest from "vitest"

import * as Shake from "../src/internal/Shake.js"
import * as Tokenizer from "../src/internal/Tokenizer.js"

const analyze = (source: string) => Shake.analyze(source, Tokenizer.scan(source))

/** Each statement's kind and text. */
const statements = (source: string) =>
  analyze(source).statements.map((statement) => [statement.kind, source.slice(statement.start, statement.end)])

const isPure = (source: string): boolean => {
  const [statement, ...rest] = analyze(source).statements
  if (statement === undefined || rest.length > 0) throw new Error(`Expected one statement: ${source}`)
  return statement.pure
}

Vitest.describe("Shake.analyze", () => {
  Vitest.it("ends statements where a semicolon would be inserted, and only there", () => {
    const source = [
      `const a = 1`,
      `const b = a`,
      `(function () {})()`,
      `let c = b`,
      `[1, 2].forEach(f)`,
      `let d = c`,
      `++d`,
      `let e = d`,
      `- 1`,
      `function f() {}`,
      `/re/.test("x")`,
      "const g = tag",
      "`b`",
      `const h = x`,
      `  .y`,
      `if (a) b()`,
      `else c()`,
      `export default a`,
      `foo()`,
      `class K {}`,
      `[k].map(f)`
    ].join("\n")
    Vitest.expect(statements(source)).toEqual([
      ["variable", "const a = 1"],
      // No semicolon before ( [ or a template, as in JavaScript
      ["variable", "const b = a\n(function () {})()"],
      ["variable", "let c = b\n[1, 2].forEach(f)"],
      ["variable", "let d = c"],
      ["other", "++d"],
      ["variable", "let e = d\n- 1"],
      ["function", "function f() {}"],
      ["other", `/re/.test("x")`],
      ["variable", "const g = tag\n`b`"],
      ["variable", "const h = x\n  .y"],
      ["other", "if (a) b()\nelse c()"],
      ["exportDefault", "export default a"],
      ["other", "foo()"],
      ["class", "class K {}"],
      ["other", "[k].map(f)"]
    ])
  })

  Vitest.it("tells imports and exports apart", () => {
    const source = [
      `import x, { a as b, "c-d" as c } from "./a.js";`,
      `import * as ns from "./b.js"`,
      `import "./c.js"`,
      `export * from "./d.js"`,
      `export * as e from "./e.js"`,
      `export { f, g as "h-i" } from "./f.js"`,
      `export { x as y, b }`,
      `export const k = 1, l = 2`,
      `export async function m() {}`,
      `export default class {}`,
      `import.meta.url`
    ].join("\n")
    const analysis = analyze(source)
    Vitest.expect(analysis.statements.map((statement) => statement.kind)).toEqual([
      "import",
      "import",
      "import",
      "exportStar",
      "exportFrom",
      "exportFrom",
      "exportList",
      "variable",
      "function",
      "class",
      "other"
    ])
    Vitest.expect(Object.fromEntries(analysis.bindings)).toEqual({
      x: { imported: "default", source: 0 },
      b: { imported: "a", source: 0 },
      c: { imported: "c-d", source: 0 },
      ns: { imported: "*", source: 1 }
    })
    Vitest.expect(Object.fromEntries(analysis.reexports)).toEqual({
      e: { imported: "*", source: 4 },
      f: { imported: "f", source: 5 },
      "h-i": { imported: "g", source: 5 }
    })
    Vitest.expect(analysis.stars).toEqual([3])
    Vitest.expect([...analysis.exports.keys()]).toEqual(["y", "b", "k", "l", "m", "default"])
  })

  Vitest.it("finds every name a destructuring declares", () => {
    const [statement] = analyze(`const { a, b: [c, d = 1], ...e } = obj, [f, , g = h] = arr, i = 2`).statements
    Vitest.expect(statement?.declares).toEqual(["a", "c", "d", "e", "f", "g", "i"])
  })

  Vitest.it("finds the module-scope names a statement uses, and the members of namespaces", () => {
    const source = [
      `import * as Lib from "./lib.js"`,
      `import * as Other from "./other.js"`,
      `import { used } from "./used.js"`,
      `const local = 1`,
      `export const value = Lib.a + Lib?.b + Lib["c"] + used.local + { local: 1 }.local + local`,
      `export const escapes = Object.keys(Other)`
    ].join("\n")
    const { statements: [, , , , value, escapes] } = analyze(source)
    // Its own name too, which is harmless
    Vitest.expect([...value!.references].sort()).toEqual(["Lib", "local", "used", "value"])
    Vitest.expect(value!.namespaces.get("Lib")).toEqual(new Set(["a", "b", "c"]))
    Vitest.expect(escapes!.namespaces.get("Other")).toBe("escape")
  })

  Vitest.it.each([
    "const a = 1, b = \"s\", c = `t${a}`, d = [a, { b }], e = -a ** 2, f = typeof a, g = a?.b",
    "const make = () => sideEffect()",
    "const later = async (x) => { await x }",
    "const fn = function () { sideEffect() }",
    "const annotated = /*#__PURE__*/ create(sideEffect())",
    "const constructed = /* @__PURE__ */ new Map([[a, f()]])",
    "const chained = /*#__PURE__*/ Context.Service()(\"key\", {})",
    "const iife = /*#__PURE__*/ function () { return sideEffect() }()",
    "const arrowPure = (x) => /*#__PURE__*/ create(x)",
    "const methods = { m() { sideEffect() }, get g() { return f() }, [k]: 1, async *gen() {} }",
    "const ternary = c ? (x) => f(x) : (y) => g(y)",
    "let uninitialized",
    "function declared() { sideEffect() }",
    "class Plain {}",
    "class Child extends Base.Member { static x = 1; y = f(); m() { f() } static n() {} [k] = 1 }",
    "class Annotated extends /*#__PURE__*/ Data.TaggedError(\"A\") {}",
    "export default () => f()"
  ])("is pure: %s", (source) => {
    Vitest.expect(isPure(source)).toBe(true)
  })

  Vitest.it.each([
    "const called = f()",
    "const constructed = new Map()",
    "const tagged = tag`x`",
    "const inTemplate = `a${f()}`",
    "const optional = a?.()",
    "const assigned = (a = 1)",
    "const incremented = a++",
    "const deleted = delete a.b",
    "const awaited = await a",
    "const ternary = c ? (x) => f(x) : g()",
    "const [first] = iterable",
    "const { a = f() } = obj",
    "const loaded = import(\"./x.js\")",
    "class Mixed extends mixin(Base) {}",
    "class Initialized { static x = f() }",
    "class Blocked { static { f() } }",
    "class Computed { [f()]() {} }",
    "export default f()",
    "f()",
    "a.b = 1"
  ])("has side effects: %s", (source) => {
    Vitest.expect(isPure(source)).toBe(false)
  })
})
