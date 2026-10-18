import * as Vitest from "vitest"

import * as Jsx from "../src/internal/Jsx.js"
import * as Tokenizer from "../src/internal/Tokenizer.js"

interface Call {
  readonly call: "jsx" | "jsxs"
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly key?: unknown
}

/** Compiles `element = <\u2026>` and evaluates it with a runtime that records its calls. */
const evaluate = (element: string, scope: Readonly<Record<string, unknown>> = {}): Call => {
  const code = Jsx.transform(`const element = ${element}`).replace(/^import \{[^}]*\} from "[^"]*";/, "")
  const runtime = (call: Call["call"]) => (type: unknown, props: Record<string, unknown>, key?: unknown): Call => ({
    call,
    type,
    props,
    ...(key === undefined ? {} : { key })
  })
  const names = Object.keys(scope)
  return new Function("_jsx", "_jsxs", "_Fragment", ...names, `${code}\nreturn element`)(
    runtime("jsx"),
    runtime("jsxs"),
    "Fragment",
    ...names.map((name) => scope[name])
  ) as Call
}

const failure = (source: string): Tokenizer.TokenizerError => {
  try {
    Jsx.transform(source)
  } catch (error) {
    if (error instanceof Tokenizer.TokenizerError) return error
    throw error
  }
  throw new Error(`Expected ${JSON.stringify(source)} not to compile`)
}

Vitest.describe("Jsx", () => {
  Vitest.it("calls the automatic runtime, imported from effect-views", () => {
    Vitest.expect(Jsx.transform(`const a = <div class="x">hi</div>`)).toBe(
      `import { jsx as _jsx } from "effect-views/jsx-runtime";` +
        `const a = /* @__PURE__ */ _jsx("div", { class: "x", children: "hi" })`
    )
    Vitest.expect(Jsx.transform(`const a = 1 < 2 && f<string>(x)`)).toBe(`const a = 1 < 2 && f<string>(x)`)
  })

  Vitest.it("imports the runtime a @jsxImportSource pragma names, with a file's extension for a path", () => {
    Vitest.expect(Jsx.transform(`/** @jsxImportSource @acme/views */\n<p />`)).toMatch(
      /^import \{ jsx as _jsx \} from "@acme\/views\/jsx-runtime";/
    )
    Vitest.expect(Jsx.transform(`/* @jsxImportSource ../../src*/\n<p />`)).toMatch(
      /^import \{ jsx as _jsx \} from "\.\.\/\.\.\/src\/jsx-runtime\.js";/
    )
    Vitest.expect(Jsx.transform(`const _jsx = 1\nconst p = <p />`)).toMatch(/^import \{ jsx as _jsx2 \}/)
    Vitest.expect(Jsx.transform(`#!/usr/bin/env node\n<p />`)).toMatch(/^#!\/usr\/bin\/env node\nimport /)
    Vitest.expect(failure(`/** @jsxRuntime classic */\n<p />`).message).toMatch(/automatic/)
  })

  Vitest.it("names elements by strings, and components by expressions", () => {
    const Card = () => null
    const Ui = { Card: { Header: () => null } }
    Vitest.expect(evaluate(`<div />`).type).toBe("div")
    Vitest.expect(evaluate(`<my-element />`).type).toBe("my-element")
    Vitest.expect(evaluate(`<svg:rect />`).type).toBe("svg:rect")
    Vitest.expect(evaluate(`<Card />`, { Card }).type).toBe(Card)
    Vitest.expect(evaluate(`<Ui.Card.Header />`, { Ui }).type).toBe(Ui.Card.Header)
    Vitest.expect(evaluate(`<></>`).type).toBe("Fragment")
  })

  Vitest.it("passes attributes in order, and the key apart", () => {
    const element = evaluate(`<a href="/x" title={title} hidden {...rest} data-a="1" xlink:href="#y" key={id} />`, {
      title: "T",
      rest: { b: 2 },
      id: 7
    })
    Vitest.expect(element).toEqual({
      call: "jsx",
      type: "a",
      props: { href: "/x", title: "T", hidden: true, b: 2, "data-a": "1", "xlink:href": "#y" },
      key: 7
    })
    Vitest.expect(Object.keys(element.props)).toEqual(["href", "title", "hidden", "b", "data-a", "xlink:href"])
    Vitest.expect(evaluate(`<p attr=<b /> />`).props["attr"]).toEqual({ call: "jsx", type: "b", props: {} })
  })

  Vitest.it("passes one child as a value and several as an array, with jsxs", () => {
    Vitest.expect(evaluate(`<p>{x}</p>`, { x: 1 })).toEqual({ call: "jsx", type: "p", props: { children: 1 } })
    Vitest.expect(evaluate(`<p>a {x} <b>c</b></p>`, { x: 1 })).toEqual({
      call: "jsxs",
      type: "p",
      props: { children: ["a ", 1, " ", { call: "jsx", type: "b", props: { children: "c" } }] }
    })
    Vitest.expect(evaluate(`<p>{/* nothing */}</p>`)).toEqual({ call: "jsx", type: "p", props: {} })
  })

  Vitest.it("trims text as React does", () => {
    const children = (element: string) => evaluate(element).props["children"]
    Vitest.expect(children(`<p>  kept  </p>`)).toBe("  kept  ")
    Vitest.expect(children(`<p>\n  first   \n     second\n\n   third\n</p>`)).toBe("first second third")
    Vitest.expect(children(`<p>  lead\n  trail  </p>`)).toBe("  lead trail  ")
    Vitest.expect(children(`<p>\n  \n</p>`)).toBeUndefined()
    Vitest.expect(children(`<p>a\tb</p>`)).toBe("a\tb")
  })

  Vitest.it("decodes HTML entities in text and attribute strings", () => {
    const element = evaluate(`<p title="a &amp; b &quot;c&quot;">&lt;&#123;&#x7D;&gt; &copy; &nbsp;&mdash;&hellip; &unknown</p>`)
    Vitest.expect(element.props).toEqual({
      title: `a & b "c"`,
      children: "<{}> \u00a9 \u00a0\u2014\u2026 &unknown"
    })
    Vitest.expect(failure(`const a = 1\nconst p = <p>Fish &bogus; chips</p>`)).toMatchObject({
      message: "Unknown HTML entity &bogus;",
      line: 2,
      column: 19
    })
  })

  Vitest.it("compiles JSX inside expressions at any depth, including templates", () => {
    const element = evaluate("<ul>{items.map((item) => <li key={item}>{`#${<b>{item}</b>}`}</li>)}</ul>", {
      items: ["a"]
    })
    Vitest.expect(element).toEqual({
      call: "jsx",
      type: "ul",
      props: { children: [{ call: "jsx", type: "li", props: { children: "#[object Object]" }, key: "a" }] }
    })
    Vitest.expect(evaluate(`cond ? <i>yes</i> : <i>no</i>`, { cond: false }).props).toEqual({ children: "no" })
  })

  Vitest.it("leaves TypeScript's angle brackets alone", () => {
    const source = [
      `const id = <T,>(value: T): T => value`,
      `const constrained = <T extends string>(value: T): Array<T> => [value]`,
      `const typed: Map<string, Array<number>> = new Map<string, Array<number>>()`,
      `const called = id<string>("x") as string satisfies string`,
      `const apply: <T>(value: T, label?: string) => T = id`,
      `type Pick = { readonly pick: <T>(items: ReadonlyArray<T>, by: (item: T) => boolean) => T | undefined }`,
      `const describe = (f: <A>(a: A) => string, label = "<B>(b) =>"): [typeof f, string] => [f, label]`,
      `const element = <p>{id<number>(1)}</p>`
    ].join("\n")
    const compiled = Jsx.transform(source)
    Vitest.expect(compiled).toContain(source.split("\n").slice(0, 7).join("\n"))
    Vitest.expect(compiled).toContain(`const element = /* @__PURE__ */ _jsx("p", { children: id<number>(1) })`)
  })

  Vitest.it("keeps the line of everything after an element", () => {
    const source = `const a = (\n  <div\n    title="x"\n  >\n    text\n    {value}\n  </div>\n)\nconst after = 1`
    const compiled = Jsx.transform(source)
    Vitest.expect(compiled.split("\n")).toHaveLength(source.split("\n").length)
    Vitest.expect(compiled.split("\n").at(-1)).toBe("const after = 1")
  })

  Vitest.it("reports mistakes with their line and column", () => {
    Vitest.expect(failure(`const a = <div>\n  <span></div>`)).toMatchObject({
      message: "Expected </span> to close <span>, not </div>",
      line: 2,
      column: 11
    })
    Vitest.expect(failure(`const a = <div>`)).toMatchObject({ message: "Unterminated JSX element", line: 1, column: 11 })
    Vitest.expect(failure(`const a = <div title=>`)).toMatchObject({ message: "Expected a JSX attribute value" })
    Vitest.expect(failure(`const a = <p>{...items}</p>`)).toMatchObject({ message: "JSX spread children are not supported" })
  })
})
