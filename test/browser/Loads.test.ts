// Placeholders the runtime loads, in a real browser: hand-written pages with
// data-load, and routes standing in for the server.
import * as Vitest from "vitest"

import * as Protocol from "../../src/internal/Protocol.js"
import * as Browser from "../support/Browser.js"
import * as Pages from "../support/Pages.js"

let browser: Browser.Browser
let served: Pages.Pages

const page = () => browser.page

/** A placeholder the runtime loads as `load` says. */
const lazy = (attributes: string, load: Protocol.Load, children: string): string =>
  `<div ${attributes} ${Pages.json(Protocol.loadAttribute, load)}>${children}</div>`

const open = async (path: string, body: string): Promise<void> => {
  served.page(path, body)
  await page().goto(`${served.url}${path}`)
  await page().waitFor("window.started")
}

const count = (request: string) => served.requests.filter((received) => received === request).length

const sleep = (ms: number) => page().evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`)

Vitest.describe.skipIf(Browser.executable === undefined)("placeholders the runtime loads, in Chromium", () => {
  Vitest.beforeAll(async () => {
    served = await Pages.serve()
    browser = await Browser.launch()
  }, 30_000)

  Vitest.afterAll(async () => {
    await browser?.close()
    await served?.close()
  })

  Vitest.it("loads once the element is in the page, in its place or in place of what it contains", async () => {
    const headers: Array<unknown> = []
    served.route("/lazy/outer", (request) => {
      headers.push([request.headers.get(Protocol.requestHeader), request.headers.get("accept")])
      return Pages.html(`<section id="outer">Loaded</section>`)
    })
    served.route("/lazy/inner", () => Pages.html(`<p>Loaded inside</p>`))
    await open("/load-page", [
      lazy(`id="outer"`, { url: "/lazy/outer", when: "load", swap: "outer" }, "Loading…"),
      lazy(`id="inner"`, { url: "/lazy/inner", when: "load", swap: "inner" }, "Loading…")
    ].join(""))
    await page().waitFor(`document.querySelector("section#outer") && document.querySelector("#inner").textContent === "Loaded inside"`)
    await sleep(100)
    Vitest.expect(await page().evaluate(`document.querySelector("#inner").hasAttribute(${JSON.stringify(Protocol.loadAttribute)})`)).toBe(true)
    // Once each, though the inner one keeps its data-load
    Vitest.expect([count("GET /lazy/outer"), count("GET /lazy/inner")]).toEqual([1, 1])
    Vitest.expect(headers).toEqual([["true", "text/html"]])
  })

  Vitest.it("loads placeholders added later, and the next one a response puts in place of the last", async () => {
    // Each page's placeholder is the same element as the last one's, loading the next page
    served.route("/feed/1", () => Pages.html(lazy(`id="feed"`, { url: "/feed/2", when: "load", swap: "outer" }, "Page 1")))
    served.route("/feed/2", () => Pages.html(`<div id="feed">Page 2</div>`))
    await open("/feed-page", `<main></main>`)
    await page().evaluate(`document.querySelector("main").innerHTML = ${JSON.stringify(lazy(`id="feed"`, { url: "/feed/1", when: "load", swap: "outer" }, "Loading…"))}`)
    await page().waitFor(`document.querySelector("#feed").textContent === "Page 2"`)
    await sleep(100)
    Vitest.expect([count("GET /feed/1"), count("GET /feed/2")]).toEqual([1, 1])
  })

  Vitest.it("loads once the element scrolls into view", async () => {
    served.route("/lazy/below", () => Pages.html(`<p id="below-content">Below</p>`))
    await open("/visible-page", [
      `<div style="height: 3000px">Tall</div>`,
      lazy(`id="below"`, { url: "/lazy/below", when: "visible", swap: "inner" }, "Loading…"),
      `<div style="height: 3000px">Tall</div>`
    ].join(""))
    await sleep(200)
    Vitest.expect(count("GET /lazy/below")).toBe(0)
    await page().evaluate(`document.querySelector("#below").scrollIntoView()`)
    await page().waitFor(`document.querySelector("#below-content")`)
    // Scrolling away and back does not load it again
    await page().evaluate(`window.scrollTo(0, 0)`)
    await sleep(100)
    await page().evaluate(`document.querySelector("#below").scrollIntoView()`)
    await sleep(200)
    Vitest.expect(count("GET /lazy/below")).toBe(1)
  })

  Vitest.it("polls every so often while in the page, and stops once a response replaces it", async () => {
    const every = 150
    const load: Protocol.Load = { url: "/poll", when: { every }, swap: "outer" }
    const polled: Array<number> = []
    served.route("/poll", () => {
      polled.push(Date.now())
      return Pages.html(polled.length < 3 ? lazy(`id="poll"`, load, String(polled.length)) : `<p id="poll">Done</p>`)
    })
    await open("/poll-page", lazy(`id="poll"`, load, "0"))
    const started = await page().evaluate<number>(`window.started`)
    await page().waitFor(`document.querySelector("p#poll")`)
    await sleep(every * 3)
    Vitest.expect(polled.length).toBe(3)
    // The first poll waits too, and each waits after the last response
    const gaps = polled.map((at, index) => at - (index === 0 ? started : polled[index - 1]!))
    for (const gap of gaps) Vitest.expect(gap).toBeGreaterThanOrEqual(every - 20)
  })

  Vitest.it("logs nothing unexpected", async () => {
    Vitest.expect(page().messages).toEqual([])
  })
})
