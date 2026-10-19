// Subscriptions to server-sent events, in a real browser: hand-written pages
// with data-subscribe, and event streams standing in for the server.
import * as Vitest from "vitest"

import * as Protocol from "../../src/internal/Protocol.js"
import * as Browser from "../support/Browser.js"
import * as Pages from "../support/Pages.js"
import * as Serve from "../support/Serve.js"

let browser: Browser.Browser
let served: Pages.Pages

const page = () => browser.page

/** The streams each path has opened, newest last. */
const streams = new Map<string, Array<Serve.EventStream>>()

/** Answers the path with a new event stream for each connection. */
const stream = (path: string): void => {
  streams.set(path, [])
  served.route(path, () => {
    const opened = Serve.eventStream()
    streams.get(path)!.push(opened)
    return opened.response
  })
}

/** Waits for the path's stream to open, and returns it. */
const connected = async (path: string): Promise<Serve.EventStream> => {
  await Vitest.expect.poll(() => streams.get(path)?.length ?? 0).toBeGreaterThan(0)
  return streams.get(path)!.at(-1)!
}

const subscribe = (tag: string, attributes: string, subscription: Protocol.Subscription, children: string): string =>
  `<${tag} ${attributes} ${Pages.json(Protocol.subscribeAttribute, subscription)}>${children}</${tag}>`

const open = async (path: string, body: string): Promise<void> => {
  served.page(path, body)
  await page().goto(`${served.url}${path}`)
  await page().waitFor("window.started")
}

const html = (selector: string) => page().evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).innerHTML`)

const sleep = (ms: number) => page().evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`)

Vitest.describe.skipIf(Browser.executable === undefined)("subscriptions the runtime opens, in Chromium", () => {
  Vitest.beforeAll(async () => {
    served = await Pages.serve()
    browser = await Browser.launch()
  }, 30_000)

  Vitest.afterAll(async () => {
    await browser?.close()
    await served?.close()
  })

  Vitest.it("puts the HTML of the events it names into the element, in place of what it contains or after that", async () => {
    stream("/sse/feed")
    stream("/sse/log")
    await open("/named-page", [
      subscribe("div", `id="feed"`, { url: "/sse/feed", events: ["todos"], swap: "inner" }, "<p>Waiting</p>"),
      subscribe("ul", `id="log"`, { url: "/sse/log", events: ["line", "other"], swap: "append" }, "")
    ].join(""))
    const feed = await connected("/sse/feed")
    const log = await connected("/sse/log")

    feed.send("todos", "<p>One</p>")
    await page().waitFor(`document.querySelector("#feed").textContent === "One"`)
    // Events it does not name are not put in; each line of the data is part of the HTML
    feed.send("unnamed", "<p>Not this</p>")
    feed.send("todos", "<p>Two</p>\n<p>Three</p>")
    await page().waitFor(`document.querySelector("#feed").textContent.includes("Three")`)
    Vitest.expect(await html("#feed")).toBe("<p>Two</p>\n<p>Three</p>")

    log.send("line", "<li>a</li>")
    log.send("other", "<li>b</li>")
    log.send("line", "<li>c</li>")
    await page().waitFor(`document.querySelectorAll("#log li").length === 3`)
    Vitest.expect(await html("#log")).toBe("<li>a</li><li>b</li><li>c</li>")
  })

  Vitest.it("puts each event's HTML into the elements inside that take it, found when it arrives", async () => {
    stream("/sse/hub")
    await open("/connect-page", subscribe("div", `id="hub"`, { url: "/sse/hub", swap: "inner" }, [
      `<p>Count: <span id="count" data-event="count">0</span></p>`,
      `<div id="status" data-event="status"><em>Idle</em></div>`,
      `<footer id="count-again" data-event="count">0</footer>`
    ].join("")))
    const hub = await connected("/sse/hub")

    hub.send("count", "5")
    hub.send("status", "<strong>Busy</strong>")
    await page().waitFor(`document.querySelector("#status").textContent === "Busy"`)
    Vitest.expect([await html("#count"), await html("#count-again"), await html("#status")])
      .toEqual(["5", "5", "<strong>Busy</strong>"])

    // One replaced since, and one that takes an event nothing listened for when the page loaded
    await page().evaluate(`(() => {
      document.querySelector("#status").outerHTML = '<section id="status" data-event="status">New</section>'
      document.querySelector("#hub").insertAdjacentHTML("beforeend", '<b id="late" data-event="late"></b>')
    })()`)
    await sleep(50)
    hub.send("status", "Done")
    hub.send("late", "<i>Late</i>")
    await page().waitFor(`document.querySelector("#late").textContent === "Late"`)
    Vitest.expect(await page().evaluate(`document.querySelector("#status").outerHTML`))
      .toBe(`<section id="status" data-event="status">Done</section>`)
  })

  Vitest.it("closes the stream when the element leaves the page", async () => {
    stream("/sse/closing")
    stream("/sse/closing-connect")
    await open("/closing-page", [
      subscribe("div", `id="closing"`, { url: "/sse/closing", events: ["x"], swap: "inner" }, ""),
      subscribe("div", `id="closing-connect"`, { url: "/sse/closing-connect", swap: "inner" }, `<p data-event="x"></p>`)
    ].join(""))
    const closing = [await connected("/sse/closing"), await connected("/sse/closing-connect")]
    for (const opened of closing) opened.send("x", "Open")
    await page().waitFor(`document.querySelector("#closing").textContent === "Open" && document.querySelector("#closing-connect").textContent === "Open"`)
    Vitest.expect(closing.map((opened) => opened.isClosed())).toEqual([false, false])

    await page().evaluate(`document.body.replaceChildren()`)
    await Vitest.expect.poll(() => closing.map((opened) => opened.isClosed())).toEqual([true, true])
    // And does not open them again
    await sleep(200)
    Vitest.expect([streams.get("/sse/closing")!.length, streams.get("/sse/closing-connect")!.length]).toEqual([1, 1])
  })

  Vitest.it("logs nothing unexpected", async () => {
    Vitest.expect(page().messages).toEqual([])
  })
})
