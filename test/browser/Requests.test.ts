// Forms the runtime submits, in a real browser: hand-written pages bind them
// with a Request command, and routes stand in for the server, answering with
// the statuses and headers in Protocol.
import * as Vitest from "vitest"

import * as Protocol from "../../src/internal/Protocol.js"
import type * as On from "../../src/On.js"
import * as Browser from "../support/Browser.js"
import * as Pages from "../support/Pages.js"

let browser: Browser.Browser
let served: Pages.Pages

const page = () => browser.page

/** A form the runtime submits, putting the response into `target` as `swap` says. */
const form = (attributes: string, target: string, swap: Protocol.Swap, children: string): string => {
  const command: On.Request = { _tag: "Request", target, swap }
  return `<form ${attributes} ${Pages.json("data-on-submit", [command])}>${children}</form>`
}

/** Opens a page at the path, and waits for the runtime to start. */
const open = async (path: string, body: string, head?: string): Promise<void> => {
  served.page(path, body, head)
  await page().goto(`${served.url}${path}`)
  await page().waitFor("window.started")
}

const submit = (selector: string) => page().evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`)

const count = (request: string) => served.requests.filter((received) => received === request).length

/** A response the test lets go of, to act while the runtime waits for it. */
const held = () => {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, released }
}

const sleep = (ms: number) => page().evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`)

Vitest.describe.skipIf(Browser.executable === undefined)("forms the runtime submits, in Chromium", () => {
  Vitest.beforeAll(async () => {
    served = await Pages.serve()
    browser = await Browser.launch()
  }, 30_000)

  Vitest.afterAll(async () => {
    await browser?.close()
    await served?.close()
  })

  Vitest.it("puts the response into its target: in its place, in place of what it contains, or after that", async () => {
    served.route("/swap/outer", () => Pages.html(`<section id="outer-box" class="new"><p>Replaced</p></section>`))
    served.route("/swap/inner", () => Pages.html(`<p>New inside</p>`))
    served.route("/swap/append", async (request) => Pages.html(`<li>${(await request.formData()).get("item")}</li>`))
    await open("/swaps", [
      `<div id="outer-box"><p>Old</p></div>`,
      form(`id="outer" action="/swap/outer" method="post"`, "#outer-box", "outer", "<button>Go</button>"),
      `<div id="inner-box" class="kept"><p>Old inside</p></div>`,
      form(`id="inner" action="/swap/inner" method="post"`, "#inner-box", "inner", "<button>Go</button>"),
      `<ul id="list"><li>one</li></ul>`,
      form(`id="append" action="/swap/append" method="post"`, "#list", "append", `<input name="item" value="two"><button>Go</button>`)
    ].join(""))
    await page().evaluate(`window.innerBox = document.querySelector("#inner-box")`)
    await submit("#outer")
    await submit("#inner")
    await submit("#append")
    await page().waitFor(`document.querySelectorAll("#list li").length === 2 && document.querySelector("section#outer-box") && document.querySelector("#inner-box").textContent === "New inside"`)
    Vitest.expect(await page().evaluate(`({
      outer: document.querySelector("#outer-box").outerHTML,
      inner: { same: window.innerBox === document.querySelector("#inner-box"), html: document.querySelector("#inner-box").outerHTML },
      list: [...document.querySelectorAll("#list li")].map((li) => li.textContent),
      path: location.pathname
    })`)).toEqual({
      outer: `<section id="outer-box" class="new"><p>Replaced</p></section>`,
      inner: { same: true, html: `<div id="inner-box" class="kept"><p>New inside</p></div>` },
      list: ["one", "two"],
      path: "/swaps"
    })
  })

  Vitest.it("puts a 422 into its target, and focuses the field the response marks with autofocus", async () => {
    const signup = (email: string, error: string) =>
      form(
        `id="signup" action="/signup" method="post"`,
        "#signup",
        "outer",
        `<input id="name" name="name" value="Ada">` +
          `<input id="email" name="email" value="${email}"${error === "" ? "" : ` aria-invalid="true" autofocus`}>` +
          `${error === "" ? "" : `<p id="error">${error}</p>`}<button>Sign up</button>`
      )
    served.route("/signup", async (request) =>
      Pages.html(signup(String((await request.formData()).get("email")), "Enter an email address with an @"), 422)
    )
    await open("/signup-page", signup("ada", ""))
    await page().evaluate(`window.before = document.querySelector("#signup")`)
    await submit("#signup")
    await page().waitFor(`document.querySelector("#error")`)
    Vitest.expect(await page().evaluate(`({
      error: document.querySelector("#error").textContent,
      focused: document.activeElement.id,
      same: window.before === document.querySelector("#signup")
    })`)).toEqual({ error: "Enter an email address with an @", focused: "email", same: true })
  })

  Vitest.it("loads the page effect-views-location names instead", async () => {
    served.route("/save", () => Pages.html("", 204, { [Protocol.locationHeader]: "/saved" }))
    served.page("/saved", `<p id="saved">Saved</p>`)
    await open("/save-page", form(`id="save" action="/save" method="post"`, "#save", "outer", "<button>Save</button>"))
    const loaded = page().loaded()
    await submit("#save")
    await loaded
    Vitest.expect(await page().evaluate(`[location.pathname, document.querySelector("#saved").textContent]`))
      .toEqual(["/saved", "Saved"])
  })

  Vitest.it("loads the page a redirect goes to, rather than putting it into the target", async () => {
    served.route("/redirect", () => new Response(null, { status: 303, headers: { location: "/redirected" } }))
    served.page("/redirected", `<p id="redirected">Redirected</p>`)
    await open("/redirect-page", `<div id="kept">Kept</div>` + form(`id="go" action="/redirect" method="post"`, "#kept", "outer", "<button>Go</button>"))
    const loaded = page().loaded()
    await submit("#go")
    await loaded
    Vitest.expect(await page().evaluate(`[location.pathname, document.querySelector("#redirected")?.textContent, document.querySelector("#kept")]`))
      .toEqual(["/redirected", "Redirected", null])
  })

  Vitest.it("puts the response where effect-views-target says, as effect-views-swap says", async () => {
    served.route("/retarget", () =>
      Pages.html(`<li>Elsewhere</li>`, 200, { [Protocol.targetHeader]: "#other", [Protocol.swapHeader]: "append" })
    )
    await open("/retarget-page", [
      `<div id="named"><p>Named</p></div>`,
      `<ul id="other"><li>First</li></ul>`,
      form(`id="retarget" action="/retarget" method="post"`, "#named", "inner", "<button>Go</button>")
    ].join(""))
    await submit("#retarget")
    await page().waitFor(`document.querySelectorAll("#other li").length === 2`)
    Vitest.expect(await page().evaluate(`[document.querySelector("#named").innerHTML, document.querySelector("#other").innerHTML]`))
      .toEqual([`<p>Named</p>`, `<li>First</li><li>Elsewhere</li>`])
  })

  Vitest.it("dispatches effect-views-event from the form once the response is in, or from the document once the form is gone", async () => {
    served.route("/event/saved", () =>
      Pages.html(`<p id="saved">Saved</p>`, 200, {
        [Protocol.eventHeader]: JSON.stringify({ "todo-saved": { id: 3 }, "list-changed": null })
      })
    )
    served.route("/event/gone", () => Pages.html(`<p id="gone">Gone</p>`, 200, { [Protocol.eventHeader]: JSON.stringify({ "form-gone": 1 }) }))
    served.route("/event/none", () =>
      Pages.html(`<p>Not put in</p>`, 200, { [Protocol.swapHeader]: "none", [Protocol.eventHeader]: JSON.stringify({ "nothing-put": true }) })
    )
    await open("/events-page", [
      `<div id="result"></div>`,
      form(`id="save" action="/event/saved" method="post"`, "#result", "inner", "<button>Save</button>"),
      form(`id="gone" action="/event/gone" method="post"`, "#gone", "outer", "<button>Go</button>"),
      form(`id="none" action="/event/none" method="post"`, "#result", "inner", "<button>None</button>"),
      `<script>
        window.heard = []
        for (const name of ["todo-saved", "list-changed", "form-gone", "nothing-put"]) {
          document.addEventListener(name, (event) => window.heard.push({
            name,
            detail: event.detail,
            from: event.target === document ? "document" : event.target.id,
            result: document.querySelector("#result").innerHTML
          }))
        }
      </script>`
    ].join(""))
    await submit("#save")
    await page().waitFor(`window.heard.length === 2`)
    await submit("#gone")
    await page().waitFor(`window.heard.length === 3`)
    await submit("#none")
    await page().waitFor(`window.heard.length === 4`)
    const saved = `<p id="saved">Saved</p>`
    Vitest.expect(await page().evaluate(`window.heard`)).toEqual([
      { name: "todo-saved", detail: { id: 3 }, from: "save", result: saved },
      { name: "list-changed", detail: null, from: "save", result: saved },
      { name: "form-gone", detail: 1, from: "document", result: saved },
      // effect-views-swap: none leaves the page as it is
      { name: "nothing-put", detail: true, from: "none", result: saved }
    ])
  })

  Vitest.it("puts an error response into the page's error target, or logs it when there is none", async () => {
    served.route("/broken", () => Pages.html(`<p id="broke">Something broke</p>`, 500))
    const body = [
      `<div id="errors"><p>An older error</p></div>`,
      `<div id="target">Untouched</div>`,
      form(`id="broken" action="/broken" method="post"`, "#target", "inner", "<button>Go</button>")
    ].join("")
    await open("/errors-page", body, `<meta name="${Protocol.configMeta}" ${Pages.json("content", { errorTarget: "#errors" } satisfies Protocol.Config)}>`)
    await submit("#broken")
    await page().waitFor(`document.querySelector("#broke")`)
    Vitest.expect(await page().evaluate(`[document.querySelector("#errors").innerHTML, document.querySelector("#target").textContent]`))
      .toEqual([`<p id="broke">Something broke</p>`, "Untouched"])

    await open("/errors-logged", body)
    const logged = page().messages.length
    await submit("#broken")
    await Vitest.expect.poll(() => page().messages.slice(logged)).toEqual([
      `error: effect-views: POST ${served.url}/broken failed with 500 Internal Server Error`
    ])
    Vitest.expect(await page().evaluate(`[document.querySelector("#errors").innerHTML, document.querySelector("#target").textContent]`))
      .toEqual([`<p>An older error</p>`, "Untouched"])
  })

  Vitest.it("ignores submits while the form waits for its response, so a double click posts once", async () => {
    const response = held()
    served.route("/slow", async () => {
      await response.released
      return Pages.html(`<p id="done">Done</p>`)
    })
    await open("/slow-page", [
      `<div id="slow-result"></div>`,
      form(`id="slow" action="/slow" method="post"`, "#slow-result", "inner", `<button id="slow-button">Go</button>`)
    ].join(""))
    await page().evaluate(`(() => {
      const button = document.querySelector("#slow-button")
      button.click()
      button.click()
      document.querySelector("#slow").requestSubmit()
    })()`)
    await sleep(100)
    response.release()
    await page().waitFor(`document.querySelector("#done")`)
    await sleep(100)
    Vitest.expect(count("POST /slow")).toBe(1)
    // Once the response is in, the form submits again
    await submit("#slow")
    await Vitest.expect.poll(() => count("POST /slow")).toBe(2)
  })

  Vitest.it("puts a GET form's fields in the query, in place of the action's", async () => {
    served.route("/search", (request) => Pages.html(`<p id="query">${new URL(request.url).search}</p>`))
    await open("/search-page", [
      `<div id="results"></div>`,
      form(`id="search" action="/search?page=2" method="get"`, "#results", "inner", `<input name="q" value="lamp shade"><button>Search</button>`)
    ].join(""))
    await submit("#search")
    await page().waitFor(`document.querySelector("#query")`)
    Vitest.expect(await page().evaluate(`document.querySelector("#query").textContent`)).toBe("?q=lamp+shade")
    Vitest.expect(count("GET /search?q=lamp+shade")).toBe(1)
  })

  Vitest.it("sends the fields, the button that submitted them, and the runtime's headers", async () => {
    const received: Array<unknown> = []
    served.route("/intent", async (request) => {
      received.push({
        type: request.headers.get("content-type")?.split(";")[0],
        request: request.headers.get(Protocol.requestHeader),
        accept: request.headers.get("accept"),
        fields: Array.from((await request.formData()).entries())
      })
      return Pages.html(`<p>Received</p>`)
    })
    const buttons = `<input name="title" value="Milk"><button name="intent" value="save">Save</button><button id="delete" name="intent" value="delete">Delete</button>`
    await open("/intent-page", [
      `<div id="intent-result"></div>`,
      form(`id="urlencoded" action="/intent" method="post"`, "#intent-result", "inner", buttons),
      form(`id="multipart" action="/intent" method="post" enctype="multipart/form-data"`, "#intent-result", "inner", buttons.replace(`id="delete"`, `id="delete-multipart"`))
    ].join(""))
    await page().evaluate(`document.querySelector("#delete").click()`)
    await Vitest.expect.poll(() => received.length).toBe(1)
    await page().evaluate(`document.querySelector("#delete-multipart").click()`)
    await Vitest.expect.poll(() => received.length).toBe(2)
    const fields = [["title", "Milk"], ["intent", "delete"]]
    Vitest.expect(received).toEqual([
      { type: "application/x-www-form-urlencoded", request: "true", accept: "text/html", fields },
      { type: "multipart/form-data", request: "true", accept: "text/html", fields }
    ])
  })

  Vitest.it("keeps what was typed into the target while the request was in flight", async () => {
    const response = held()
    const profile = (name: string, bio: string, saved: boolean) =>
      form(
        `id="profile" action="/profile" method="post"`,
        "#profile",
        "outer",
        `<input id="name" name="name" value="${name}"><textarea id="bio" name="bio">${bio}</textarea>` +
          `${saved ? `<p id="saved">Saved</p>` : ""}<button>Save</button>`
      )
    const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
    served.route("/profile", async (request) => {
      const fields = await request.formData()
      await response.released
      // The server tidies what it received
      return Pages.html(profile(capitalized(String(fields.get("name"))), capitalized(String(fields.get("bio"))), true))
    })
    await open("/profile-page", profile("", "", false))
    await page().evaluate(`document.querySelector("#bio").focus()`)
    await page().type("mathematician")
    await page().evaluate(`document.querySelector("#name").focus()`)
    await page().type("ada")
    await submit("#profile")
    // Typed after the request was sent, so newer than what the server says
    await page().type(" lovelace")
    response.release()
    await page().waitFor(`document.querySelector("#saved")`)
    Vitest.expect(await page().evaluate(`({
      name: document.querySelector("#name").value,
      bio: document.querySelector("#bio").value,
      focused: document.activeElement.id
    })`)).toEqual({ name: "ada lovelace", bio: "Mathematician", focused: "name" })
  })

  Vitest.it("logs nothing but the error it was asked to", async () => {
    Vitest.expect(page().messages.filter((message) => !message.includes("/broken failed with 500"))).toEqual([])
  })
})
