/** @jsxImportSource effect-views */

// The effect-views runtime, in a real browser: an application with a live
// component that runs on the server and one that runs in the browser, built
// with Assets.layer({ api }), served over HTTP and used in Chromium.
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as Vitest from "vitest"

import * as Assets from "../../src/Assets.js"
import * as Form from "../../src/Form.js"
import * as Html from "../../src/Html.js"
import * as HttpViewEndpoint from "../../src/HttpViewEndpoint.js"
import * as LiveComponent from "../../src/LiveComponent.js"
import * as Counter from "../fixtures/Counter.js"
import { ToggleHandlers } from "../fixtures/Toggle.browser.js"
import * as Toggle from "../fixtures/Toggle.js"
import * as Browser from "../support/Browser.js"
import * as Serve from "../support/Serve.js"

let searchesRun = 0

const CounterHandlers = LiveComponent.server(Counter.View, {
  increment: (state) => Effect.succeed(new Counter.CounterState({ ...state, count: state.count + 1 })),
  add: (state, { by }) => Effect.succeed(new Counter.CounterState({ ...state, count: state.count + by })),
  search: (state, { query }) =>
    Effect.sync(() => {
      searchesRun++
      return new Counter.CounterState({ ...state, query, searches: state.searches + 1 })
    }),
  note: (state, { note }) => Effect.succeed(new Counter.CounterState({ ...state, notes: [...state.notes, note] }))
})

const group = HttpApiGroup.make("pages")
  .add(HttpViewEndpoint.get("home", "/"))
  .add(HttpViewEndpoint.post("panel", "/panel"))
  .add(...LiveComponent.endpoints(Counter.Counter))
  .add(...LiveComponent.endpoints(Toggle.Toggle))

const Api = HttpApi.make("test").add(group).add(Assets.group)

/** Both components, as the page first shows them, or with the count the server says. */
const Panel = ({ count }: { readonly count: number }) => (
  <>
    <Counter.View state={new Counter.CounterState({ count, query: "", searches: 0, notes: [] })} />
    <Toggle.View state={new Toggle.ToggleState({ on: false, label: "Lamp", count: 0 })} />
  </>
)

const home = () =>
  Effect.sync(() =>
    Html.document(
      <html lang="en">
        <head>
          <Assets.Head />
        </head>
        <body>
          <section id="panel"><Panel count={0} /></section>
          {/* The page's own form, whose response renders both components again */}
          <form method="post" action="/panel" {...Form.target("#panel", "inner")}>
            <button id="replace-panel">Replace</button>
          </form>
        </body>
      </html>
    )
  )

const app = () =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide([
        HttpApiBuilder.group(Api, "pages", (handlers) =>
          handlers.handle("home", home).handle("panel", () => Effect.succeed(<Panel count={41} />))
            .pipe(LiveComponent.handle(Counter.Counter, Toggle.Toggle))).pipe(
            Layer.provide([CounterHandlers, ToggleHandlers])
          ),
        Assets.groupLayer(Api)
      ]),
      Layer.provideMerge(
        Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer, Assets.layer({ api: Api }))
      )
    ),
    { disableLogger: true }
  )

let browser: Browser.Browser
let served: Serve.Served
let dispose: () => Promise<void>

const page = () => browser.page
const text = (selector: string) => page().evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).textContent`)

Vitest.describe.skipIf(Browser.executable === undefined)("the runtime, in Chromium", () => {
  Vitest.beforeAll(async () => {
    const web = app()
    dispose = web.dispose
    served = await Serve.serve(web.handler)
    browser = await Browser.launch()
  }, 30_000)

  Vitest.afterAll(async () => {
    await browser?.close()
    await served?.close()
    await dispose?.()
  })

  Vitest.beforeEach(async () => {
    searchesRun = 0
    await page().goto(`${served.url}/`)
    // Both components start: the browser one once its module has loaded
    await page().waitFor(`document.querySelector("test-toggle button") && performance.getEntriesByType("resource").some((entry) => entry.name.includes("Toggle"))`)
  })

  Vitest.it("posts a server component's actions and updates it in place", async () => {
    const button = `document.querySelector("#increment")`
    await page().evaluate(`(window.before = ${button}).click()`)
    await page().waitFor(`document.querySelector("#count").textContent === "1"`)
    await page().evaluate(`document.querySelector("#add-five").click()`)
    await page().waitFor(`document.querySelector("#count").textContent === "6"`)
    // The same elements, updated rather than replaced
    Vitest.expect(await page().evaluate(`window.before === ${button}`)).toBe(true)
    Vitest.expect(served.requests.filter((request) => request.startsWith("POST"))).toEqual([
      "POST /live/test-server-counter/increment",
      "POST /live/test-server-counter/add"
    ])
  })

  Vitest.it("runs a server component's actions one at a time, so quick clicks all count", async () => {
    // Both clicks before either response: each request sends the state the last one returned
    await page().evaluate(`(() => { const button = document.querySelector("#increment"); button.click(); button.click() })()`)
    await page().waitFor(`document.querySelector("#count").textContent === "2"`)
    await page().evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`)
    Vitest.expect(await text("#count")).toBe("2")
  })

  Vitest.it("clears a field the server renders empty, and runs a bound submit button instead of submitting", async () => {
    await page().evaluate(`document.querySelector("#note").focus()`)
    await page().type("milk")
    await page().evaluate(`document.querySelector("#add-note").click()`)
    await page().waitFor(`document.querySelector("#note-list").textContent === "milk"`)
    Vitest.expect(await page().evaluate(`({ value: document.querySelector("#note").value, path: location.pathname })`))
      .toEqual({ value: "", path: "/" })
  })

  Vitest.it("debounces a server action, sends the component's inputs, and keeps focus and caret", async () => {
    await page().evaluate(`document.querySelector("#query").focus()`)
    await page().type("lamp")
    await page().waitFor(`document.querySelector("#searched").textContent === "1: lamp"`)
    // One request after typing paused, not one per key
    Vitest.expect(searchesRun).toBe(1)
    Vitest.expect(await page().evaluate(`(() => {
      const input = document.querySelector("#query")
      return { focused: document.activeElement === input, caret: input.selectionStart, value: input.value }
    })()`)).toEqual({ focused: true, caret: 4, value: "lamp" })
  })

  Vitest.it("runs a browser component's actions in the browser, without requests", async () => {
    const posts = served.requests.filter((request) => request.startsWith("POST")).length
    await page().evaluate(`document.querySelector("test-toggle button").click()`)
    await page().waitFor(`document.querySelector("test-toggle button").getAttribute("aria-pressed") === "true"`)

    // A value read from the input when the event happens
    await page().evaluate(`(() => { const input = document.querySelector("test-toggle input"); input.focus(); input.select() })()`)
    await page().type("Heater")
    await page().waitFor(`document.querySelector("test-toggle button").textContent === "Heater"`)
    Vitest.expect(await page().evaluate(`document.activeElement === document.querySelector("test-toggle input")`)).toBe(true)

    // A key binding: ArrowUp adds one; Enter is not bound, so it keeps its usual behaviour
    await page().evaluate(`document.querySelectorAll("test-toggle input")[1].focus()`)
    await page().press("ArrowUp")
    await page().press("ArrowUp")
    await page().waitFor(`document.querySelectorAll("test-toggle button")[1].textContent === "2"`)
    // Escape is bound further out, and the input's bindings leave it to that one
    await page().press("Escape")
    await page().waitFor(`document.querySelector("test-toggle button").getAttribute("aria-pressed") === "false"`)
    Vitest.expect(served.requests.filter((request) => request.startsWith("POST")).length).toBe(posts)
    Vitest.expect(await text("test-toggle")).toContain("Heater")
  })

  Vitest.it("starts components added to the page later, and stops ones removed", async () => {
    const result = await page().evaluate<Record<string, unknown>>(`(async () => {
      const original = document.querySelector("test-toggle")
      const copy = original.cloneNode(true)
      original.remove()
      document.body.append(copy)
      await new Promise((resolve) => setTimeout(resolve, 100))
      copy.querySelector("button").click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { pressed: copy.querySelector("button").getAttribute("aria-pressed") }
    })()`)
    Vitest.expect(result).toEqual({ pressed: "true" })
  })

  Vitest.it("shows what the server renders for the page, starting browser components again with its state", async () => {
    // Change the browser component, so its state differs from what the server renders, though it rendered it before
    await page().evaluate(`(window.before = document.querySelector("test-toggle")).querySelector("button").click()`)
    await page().evaluate(`document.querySelectorAll("test-toggle button")[1].click()`)
    await page().waitFor(`document.querySelectorAll("test-toggle button")[1].textContent === "5"`)
    await page().evaluate(`document.querySelector("#replace-panel").click()`)
    await page().waitFor(`document.querySelector("#count").textContent === "41"`)
    await page().waitFor(`document.querySelectorAll("test-toggle button")[1].textContent === "0"`)
    Vitest.expect(await page().evaluate(`({
      same: window.before === document.querySelector("test-toggle"),
      pressed: document.querySelector("test-toggle button").getAttribute("aria-pressed")
    })`)).toEqual({ same: true, pressed: "false" })
    // Both carry on from the server's state: 0 + 5, and 41 + 1
    await page().evaluate(`document.querySelectorAll("test-toggle button")[1].click()`)
    await page().evaluate(`document.querySelector("#increment").click()`)
    await page().waitFor(`document.querySelector("#count").textContent === "42"`)
    await page().waitFor(`document.querySelectorAll("test-toggle button")[1].textContent === "5"`)
    // Once: the component that started again is the only one running
    await page().evaluate(`new Promise((resolve) => setTimeout(resolve, 100))`)
    Vitest.expect(await text("test-toggle")).toContain("5")
    Vitest.expect(await page().evaluate(`document.querySelectorAll("test-toggle button")[1].textContent`)).toBe("5")
  })

  Vitest.it("logs nothing unexpected", async () => {
    await page().evaluate(`document.querySelector("#increment").click()`)
    await page().waitFor(`document.querySelector("#count").textContent === "1"`)
    Vitest.expect(page().messages.filter((message) => !message.includes("favicon"))).toEqual([])
  })
})
