/** @jsxImportSource effect-views */

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { fileURLToPath } from "node:url"
import * as Vitest from "vitest"

import * as Assets from "../src/Assets.js"
import * as Html from "../src/Html.js"
import * as Manifest from "../src/internal/Manifest.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"
import * as LiveAction from "../src/LiveAction.js"
import * as LiveComponent from "../src/LiveComponent.js"
import * as On from "../src/On.js"
import { ToggleHandlers } from "./fixtures/Toggle.browser.js"
import * as Toggle from "./fixtures/Toggle.js"

const initial = new Toggle.ToggleState({ on: false, label: "Lamp", count: 0 })

const group = HttpApiGroup.make("pages")
  .add(HttpViewEndpoint.get("home", "/"))
  .add(...LiveComponent.endpoints(Toggle.Toggle))

const Api = HttpApi.make("test").add(group).add(Assets.group)

const makeApp = (options?: Assets.Options) => {
  const handlers = HttpApiBuilder.group(Api, "pages", (handlers) =>
    handlers
      .handle("home", () => Effect.succeed(<><Assets.Head /><Toggle.View state={initial} /></>))
      .pipe(LiveComponent.handle(Toggle.Toggle))).pipe(Layer.provide(ToggleHandlers))
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide([handlers, Assets.groupLayer(Api)]),
      Layer.provideMerge(
        Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer, Assets.layer({ htmx: false, api: Api, ...options }))
      )
    ),
    { disableLogger: true }
  )
}

const get = async (handler: (request: Request) => Promise<Response>, path: string) => {
  const response = await handler(new Request(`http://localhost${path}`))
  return { status: response.status, headers: response.headers, body: await response.text() }
}

const attribute = (body: string, name: string) => {
  const value = new RegExp(`${name}="([^"]*)"`).exec(body)?.[1]
  return value?.replaceAll("&quot;", "\"").replaceAll("&amp;", "&")
}

// Type checks -------------------------------------------------------------------

export const typeChecks = () => [
  LiveComponent.view(Toggle.Toggle, {
    render: (_state, actions) => {
      // @ts-expect-error a browser action takes all of its values
      actions.rename({})
      // @ts-expect-error On.value is text, and by is an Int encoded as a number
      actions.add({ by: On.value })
      return <button {...On.click(actions.toggle())} />
    }
  }),
  // @ts-expect-error server handlers are for components that run on the server
  LiveComponent.server(Toggle.View, {}),
  LiveComponent.browser(Toggle.View, {
    // @ts-expect-error handlers that need services must be given a layer
    toggle: () => Effect.asVoid(Assets.Assets),
    rename: () => Effect.void,
    add: () => Effect.void
  })
]

// Tests -------------------------------------------------------------------------

Vitest.describe("LiveComponent in the browser", () => {
  Vitest.it("renders its state as JSON, its module, and its actions as event bindings", () => {
    const body = Html.render(<Toggle.View state={initial} />)
    // Without Assets.layer, the module comes from the component's own endpoint
    Vitest.expect(body).toMatch(
      /^<test-toggle data-live="browser" data-live-module="\/live\/test-toggle\/module.js" data-live-state="[^"]+" data-component>/
    )
    Vitest.expect(JSON.parse(attribute(body, "data-live-state")!)).toEqual({ on: false, label: "Lamp", count: 0 })
    Vitest.expect(JSON.parse(attribute(body, "data-on-click")!)).toEqual([{ _tag: "Action", action: "toggle", payload: {} }])
    // Values known when rendering are encoded; placeholders are read when the event happens
    Vitest.expect(body).toContain(`data-on-click="[{&quot;_tag&quot;:&quot;Action&quot;,&quot;action&quot;:&quot;add&quot;,&quot;payload&quot;:{&quot;by&quot;:5}}]"`)
    Vitest.expect(JSON.parse(attribute(body, "data-on-input")!)).toEqual([
      { _tag: "Action", action: "rename", payload: { label: { "~effect-views/On/Placeholder": "value" } } }
    ])
    // Keys left undefined keep their usual behaviour
    const keyBindings = [...body.matchAll(/data-on-keydown="([^"]+)"/g)].map((match) =>
      Object.keys(JSON.parse(match[1]!.replaceAll("&quot;", "\"")))
    )
    Vitest.expect(keyBindings).toEqual([["Escape"], ["ArrowUp", "ArrowDown"]])
    // No signed state: it never goes back to the server
    Vitest.expect(body).not.toContain(LiveComponent.stateField)
  })

  Vitest.it("puts a JSX key on its element, so a list of components keeps each one's state", () => {
    Vitest.expect(Html.render(<Toggle.View key="lamp" state={initial} />)).toMatch(/^<test-toggle [^>]*data-key="lamp"/)
  })

  Vitest.it("has one endpoint, for its code", () => {
    const endpoints = LiveComponent.endpoints(Toggle.Toggle)
    Vitest.expect(endpoints.map((endpoint) => [endpoint.method, endpoint.path])).toEqual([["GET", "/live/test-toggle/module.js"]])
  })

  Vitest.it("reads the module's file from stack frames, including paths with parentheses", () => {
    Vitest.expect(Manifest.frameFile("    at file:///home/u/proj%20(copy)/Lines.js:3:9")).toBe("file:///home/u/proj%20(copy)/Lines.js")
    Vitest.expect(Manifest.frameFile("    at Object.<anonymous> (/home/u/proj (copy)/Lines.js:3:9)")).toBe("/home/u/proj (copy)/Lines.js")
    Vitest.expect(Manifest.frameFile("    at async View (C:\\app\\Lines.js:1:2)")).toBe("C:\\app\\Lines.js")
    Vitest.expect(Manifest.frameFile("    at new Promise (<anonymous>)")).toBeUndefined()
  })

  Vitest.it("records the module that defines its browser handlers", () => {
    Vitest.expect(LiveComponent.browserDefinition("test-toggle")?.file).toBe(
      fileURLToPath(new URL("./fixtures/Toggle.browser.ts", import.meta.url))
    )
    Vitest.expect(() => LiveComponent.browser(Toggle.View, {
      toggle: () => Effect.void,
      rename: () => Effect.void,
      add: () => Effect.void
    })).toThrow(/already has browser handlers/)
  })

  Vitest.it("is bundled when Assets.layer is built, with the runtime, and loaded by the head and the view", async () => {
    const { dispose, handler } = makeApp()
    try {
      const page = await get(handler, "/")
      const module = attribute(page.body, "data-live-module")!
      Vitest.expect(module).toMatch(/^\/assets\/Toggle_browser-[0-9a-f]{12}\.js$/)
      // The runtime, from the head, and the modules it imports, preloaded
      const runtime = /<script type="module" src="(\/assets\/start-[0-9a-f]{12}\.js)">/.exec(page.body)?.[1]
      Vitest.expect(runtime).toBeDefined()
      Vitest.expect(page.body).toMatch(/<link rel="modulepreload" href="\/assets\/runtime-[0-9a-f]{12}\.js">/)

      const code = await get(handler, module)
      Vitest.expect(code.status).toBe(200)
      Vitest.expect(code.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      Vitest.expect(code.headers.get("cache-control")).toContain("immutable")
      // Imports point at other bundled files, and nothing needs Node
      const imports = [...code.body.matchAll(/from\s*"([^"]+)"/g)].map((match) => match[1]!)
      Vitest.expect(imports.length).toBeGreaterThan(0)
      for (const path of imports) Vitest.expect(path).toMatch(/^\/assets\/[\w-]+-[0-9a-f]{12}\.js$/)
      Vitest.expect(code.body).not.toMatch(/["']node:/)

      // The component's own endpoint points at the bundled module
      const stable = await get(handler, "/live/test-toggle/module.js")
      Vitest.expect(stable.status).toBe(200)
      Vitest.expect(stable.body).toBe(`import ${JSON.stringify(module)}\n`)
    } finally {
      await dispose()
    }
  })

  Vitest.it("refuses to build when a component in the API has no browser handlers loaded", async () => {
    const Missing = LiveComponent.make("test-missing", { state: Schema.Struct({}), runs: "browser" })
    const api = HttpApi.make("missing").add(HttpApiGroup.make("pages").add(...LiveComponent.endpoints(Missing)))
    const exit = await Effect.runPromiseExit(Assets.make({ htmx: false, api }))
    Vitest.expect(String(exit)).toMatch(/test-missing> runs in the browser, but the module that calls LiveComponent.browser/)
  })
})

Vitest.describe("LiveComponent on the server", () => {
  Vitest.it("tells the runtime how to run switch and debounced actions", () => {
    const Search = LiveComponent.make("test-search", { state: Schema.Struct({ query: Schema.String }) })
      .add(LiveAction.make("search", { payload: { query: Schema.String }, debounce: "200 millis" }))
      .add(LiveAction.make("clear", { concurrency: "switch" }))
    const SearchView = LiveComponent.view(Search, {
      render: (state, actions) => (
        <>
          <input name="query" value={state.query} {...On.input(actions.search())} />
          <button {...On.click(actions.clear())} />
        </>
      )
    })
    const body = Html.render(<SearchView state={{ query: "" }} />)
    Vitest.expect(JSON.parse(attribute(body, "data-on-input")!)).toEqual([
      { _tag: "Server", action: "search", url: "/live/test-search/search", payload: {}, concurrency: "switch", debounce: 200 }
    ])
    Vitest.expect(JSON.parse(attribute(body, "data-on-click")!)[0].concurrency).toBe("switch")
  })

  Vitest.it("needs the runtime, which Assets.layer bundles when the API has live components", async () => {
    const Counter = LiveComponent.make("test-needs-runtime", { state: Schema.Struct({}) }).add(LiveAction.make("go"))
    const CounterView = LiveComponent.view(Counter, { render: () => <p /> })
    const withoutApi = await Effect.runPromise(Assets.make({ htmx: false }))
    Vitest.expect(() => Effect.runSync(Effect.sync(() => Html.render(<CounterView state={{}} />)).pipe(
      Effect.provideService(Assets.Assets, withoutApi)
    ))).toThrow(/needs the effect-views runtime; give Assets.layer the API/)
    // While handling a request with no Assets.layer at all
    Vitest.expect(() => Effect.runSync(Effect.sync(() => Html.render(<CounterView state={{}} />)).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("http://localhost/")))
    ))).toThrow(/provide Assets.layer\(\{ api \}\) to HttpRouter.serve/)
    // Outside a request, such as in a test, it renders
    Vitest.expect(Html.render(<CounterView state={{}} />)).toContain(`data-live="server"`)
  })
})

Vitest.describe("On", () => {
  Vitest.it("binds events to commands as data", () => {
    const command: On.Command = { _tag: "Action", action: "save", payload: {} }
    Vitest.expect(On.click(command)).toEqual({ "data-on-click": `[{"_tag":"Action","action":"save","payload":{}}]` })
    Vitest.expect(On.event("pointerdown", command, command)["data-on-pointerdown"]).toBe(JSON.stringify([command, command]))
    // Only events the runtime listens for, which bubble
    Vitest.expect(() => On.event("focus" as On.EventName, command)).toThrow(/does not handle "focus" events/)
    Vitest.expect(On.isPlaceholder(On.value)).toBe(true)
    Vitest.expect(On.isPlaceholder({ value: 1 })).toBe(false)
  })
})

Vitest.describe("JSX keys", () => {
  Vitest.it("render as data-key, for the browser runtime to match elements across renders", () => {
    Vitest.expect(Html.render(<ul>{["a", "b"].map((item) => <li key={item}>{item}</li>)}</ul>)).toBe(
      `<ul><li data-key="a">a</li><li data-key="b">b</li></ul>`
    )
  })
})
