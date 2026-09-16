/** @jsxImportSource effect-views */

import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"

Vitest.describe("Html", () => {
  Vitest.it("escapes string children and attribute values", () => {
    const name = `<Admin & "friends">`
    const view = <p title={name}>Hello, {name}</p>

    Vitest.expect(Html.render(view)).toBe(
      `<p title="&lt;Admin &amp; &quot;friends&quot;&gt;">Hello, &lt;Admin &amp; &quot;friends&quot;&gt;</p>`
    )
  })

  Vitest.it("composes components without re-escaping Html", () => {
    const Badge = ({ children }: { readonly children: Html.Child }) =>
      <strong className="badge">{children}</strong>

    const view = <div><Badge>Ready</Badge><br /></div>

    Vitest.expect(Html.render(view)).toBe(
      `<div><strong class="badge">Ready</strong><br></div>`
    )
  })

  Vitest.it("escapes string children and passes unsafe markup through", () => {
    Vitest.expect(Html.render(Html.fragment("<em>escaped</em>", Html.unsafe("<em>trusted</em>"))))
      .toBe("&lt;em&gt;escaped&lt;/em&gt;<em>trusted</em>")
  })

  Vitest.it("rejects onclick, srcdoc, and an obfuscated javascript URL", () => {
    Vitest.expect(() => Html.element("button", { onclick: "alert(1)" })).toThrow(/Unsafe HTML attribute/)
    Vitest.expect(() => Html.element("iframe", { srcdoc: "<script>alert(1)</script>" })).toThrow(/Unsafe HTML attribute/)
    Vitest.expect(() => Html.element("a", { href: "java\nscript:alert(1)" })).toThrow(/Unsafe URL/)
  })

  Vitest.it("encodes as a string through the HttpApi schema", () => {
    const view = <h1>Hello</h1>
    Vitest.expect(Schema.encodeSync(Html.schema)(view)).toBe("<h1>Hello</h1>")
  })
})
