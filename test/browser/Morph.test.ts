// The morph, in a real browser: the page loads src/client/morph.ts, bundled
// for the browser by effect-views' own bundler.
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"
import * as Vitest from "vitest"

import * as Bundler from "../../src/internal/Bundler.js"
import * as Browser from "../support/Browser.js"
import * as Serve from "../support/Serve.js"

const entry = fileURLToPath(new URL("../../src/client/morph.ts", import.meta.url))

let browser: Browser.Browser
let served: Serve.Served

/** Runs a scenario in the page, with the morph functions in scope, and returns its result. */
const run = <A>(scenario: string): Promise<A> =>
  browser.page.evaluate<A>(`(() => {
    const { morphChildren, morphElement } = window.morph
    const root = document.createElement("div")
    document.body.replaceChildren(root)
    ${scenario}
  })()`)

Vitest.describe.skipIf(Browser.executable === undefined)("morph, in Chromium", () => {
  Vitest.beforeAll(async () => {
    const bundle = await Effect.runPromise(Bundler.bundle({ entries: [entry], prefix: "/assets" }))
    const module = bundle.entries.get(entry)!
    const files = new Map<string, { contentType: string; body: Uint8Array | string }>(
      bundle.files.map((file) => [file.path, file])
    )
    files.set("/", {
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><body><script type="module">import * as morph from "${module}"; window.morph = morph</script>`
    })
    served = await Serve.serveFiles(files)
    browser = await Browser.launch()
    await browser.page.goto(`${served.url}/`)
    await browser.page.waitFor("window.morph")
  }, 30_000)

  Vitest.afterAll(async () => {
    await browser?.close()
    await served?.close()
  })

  Vitest.it("moves keyed elements instead of recreating them, and removes the ones that are gone", async () => {
    const result = await run<Record<string, unknown>>(`
      root.innerHTML = '<ul><li data-key="a">A</li><li data-key="b">B</li><li data-key="c">C</li></ul>'
      const [a, b, c] = root.querySelectorAll("li")
      morphChildren(root, '<ul><li data-key="c">C!</li><li data-key="a">A</li><li data-key="d">D</li></ul>')
      const items = [...root.querySelectorAll("li")]
      return { text: items.map((li) => li.textContent), sameC: items[0] === c, sameA: items[1] === a, bGone: !b.isConnected }
    `)
    Vitest.expect(result).toEqual({ text: ["C!", "A", "D"], sameC: true, sameA: true, bGone: true })
  })

  Vitest.it("keeps focus, the caret and what was typed, unless the state changed the field", async () => {
    const result = await run<Record<string, unknown>>(`
      root.innerHTML = '<label>Title <input value="ab"></label>'
      const input = root.querySelector("input")
      input.focus()
      // Typed since the last render, which the state has not caught up with
      input.value = "abc"
      input.setSelectionRange(1, 1)
      morphChildren(root, '<label>Title <input value="ab"></label>')
      const kept = { value: input.value, caret: input.selectionStart, focused: document.activeElement === input }
      // The state changed the field, such as an option chosen from a list
      morphChildren(root, '<label>Title <input value="Ada Lovelace"></label>')
      return { kept, changed: input.value, same: root.querySelector("input") === input, focused: document.activeElement === input }
    `)
    Vitest.expect(result).toEqual({
      kept: { value: "abc", caret: 1, focused: true },
      changed: "Ada Lovelace",
      same: true,
      focused: true
    })
  })

  Vitest.it("updates checkboxes, selects and text areas through their properties", async () => {
    const result = await run<Record<string, unknown>>(`
      root.innerHTML = '<input type="checkbox"><select><option value="a">A</option><option value="b">B</option></select><textarea>one</textarea>'
      const [box, select, area] = [root.querySelector("input"), root.querySelector("select"), root.querySelector("textarea")]
      // Used, so attributes alone no longer change what they show
      box.checked = false
      select.value = "a"
      area.value = "typed"
      morphChildren(root, '<input type="checkbox" checked><select><option value="a">A</option><option value="b" selected>B</option></select><textarea>two</textarea>')
      return { checked: box.checked, selected: select.value, text: area.value }
    `)
    Vitest.expect(result).toEqual({ checked: true, selected: "b", text: "two" })
  })

  Vitest.it("adds, changes and removes attributes, keeping those named in data-keep", async () => {
    const result = await run<Record<string, unknown>>(`
      root.innerHTML = '<details data-keep="open" class="a" title="old"><summary>More</summary></details>'
      const details = root.querySelector("details")
      details.open = true
      morphChildren(root, '<details data-keep="open" class="b" hidden><summary>More</summary></details>')
      return { open: details.open, class: details.className, title: details.getAttribute("title"), hidden: details.hidden }
    `)
    Vitest.expect(result).toEqual({ open: true, class: "b", title: null, hidden: true })
  })

  Vitest.it("leaves components inside alone, since they render themselves", async () => {
    const result = await run<string>(`
      root.innerHTML = '<p>Parent</p><child-part data-live="browser"><p>Its own</p></child-part>'
      root.querySelector("child-part p").textContent = "Changed by the child"
      morphChildren(root, '<p>Parent again</p><child-part data-live="browser"><p>Rendered by the parent</p></child-part>')
      return root.textContent
    `)
    Vitest.expect(result).toBe("Parent againChanged by the child")
  })

  Vitest.it("moves keyed components and drops the one removed, without touching what is inside them", async () => {
    const result = await run<Record<string, unknown>>(`
      root.innerHTML = ["a", "b", "c"].map((key) => '<app-item data-live="browser" data-key="' + key + '"><p>' + key + '</p></app-item>').join("")
      const [a, b, c] = root.querySelectorAll("app-item")
      c.querySelector("p").textContent = "c, changed by itself"
      morphChildren(root, ["c", "b"].map((key) => '<app-item data-live="browser" data-key="' + key + '"><p>' + key + '</p></app-item>').join(""))
      const items = [...root.querySelectorAll("app-item")]
      return { order: items.map((item) => item.dataset.key), same: items[0] === c && items[1] === b, aGone: !a.isConnected, inside: c.textContent }
    `)
    Vitest.expect(result).toEqual({ order: ["c", "b"], same: true, aGone: true, inside: "c, changed by itself" })
  })

  Vitest.it("updates an element from markup for itself, or replaces it when the tag differs", async () => {
    const result = await run<Record<string, unknown>>(`
      root.innerHTML = '<app-counter data-live="server" data-n="1"><output>1</output><input value="x"></app-counter>'
      const host = root.querySelector("app-counter")
      const input = host.querySelector("input")
      morphElement(host, '<app-counter data-live="server" data-n="2"><output>2</output><input value="x"></app-counter>')
      const updated = { same: root.querySelector("app-counter") === host, n: host.dataset.n, output: host.querySelector("output").textContent, input: host.querySelector("input") === input }
      morphElement(host, '<p>Gone</p>')
      return { updated, replaced: root.innerHTML }
    `)
    Vitest.expect(result).toEqual({ updated: { same: true, n: "2", output: "2", input: true }, replaced: "<p>Gone</p>" })
  })

  Vitest.it("updates text and replaces elements whose tag changed", async () => {
    const result = await run<string>(`
      root.innerHTML = '<p>One</p><span>Two</span>'
      morphChildren(root, '<p>Uno</p><strong>Dos</strong><em>Tres</em>')
      return root.innerHTML
    `)
    Vitest.expect(result).toBe("<p>Uno</p><strong>Dos</strong><em>Tres</em>")
  })
})
