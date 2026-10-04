/** @jsxImportSource effect-views */

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as OpenApi from "effect/http-api/OpenApi"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"
import * as LiveAction from "../src/LiveAction.js"
import * as LiveComponent from "../src/LiveComponent.js"

// The contract ------------------------------------------------------------------

class CounterState extends Schema.Class<CounterState>("CounterState")({
  count: Schema.Int,
  label: Schema.String
}) {}

const Counter = LiveComponent.make("test-counter", { state: CounterState })
  .add(LiveAction.make("increment"))
  .add(LiveAction.make("add", { payload: { by: Schema.Int }, description: "Add to the count" }))
  .add(LiveAction.make("rename", { payload: { label: Schema.NonEmptyString } }))

// The view ----------------------------------------------------------------------

const CounterView = LiveComponent.view(Counter, {
  render: (state, actions) => (
    <>
      <output>{state.label}: {state.count}</output>
      <button type="button" {...actions.increment()}>+</button>
      <button type="button" {...actions.add({ by: 5 })}>+5</button>
      <input name="label" value={state.label} {...actions.rename()} />
    </>
  )
})

// The handlers ------------------------------------------------------------------

/** A service the handlers use, to show that they can depend on the application. */
class Step extends Context.Service<Step, { readonly size: number }>()("test/Step") {}

const CounterHandlers = LiveComponent.handlers(CounterView, {
  increment: (state) =>
    Effect.gen(function* () {
      const { size } = yield* Step
      return new CounterState({ ...state, count: state.count + size })
    }),
  add: (state, { by }) => Effect.succeed(new CounterState({ ...state, count: state.count + by })),
  rename: (state, { label }) => Effect.succeed(new CounterState({ ...state, label }))
}).pipe(Layer.provide(Layer.succeed(Step)({ size: 2 })))

// The API, with middleware on the live group ------------------------------------

class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}, { httpApiStatus: 403 }) {}

/** Lets requests through only with an `x-allowed` header, like an authentication check. */
class Gate extends HttpApiMiddleware.Service<Gate>()("test/Gate", { error: Forbidden }) {}

const GateLive = Layer.succeed(Gate)((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.headers["x-allowed"] !== "yes") return yield* new Forbidden()
    return yield* httpEffect
  }))

// The live component's actions sit in the group of the views they belong to
const CounterGroup = HttpApiGroup.make("counter")
  .add(HttpViewEndpoint.get("page", "/counter"))
  .add(...LiveComponent.endpoints(Counter))
  .middleware(Gate)

const Api = HttpApi.make("TestApi").add(CounterGroup)

const counterPage = () => Effect.succeed(<CounterView state={new CounterState({ count: 0, label: "Clicks" })} />)

const CounterLayer = HttpApiBuilder.group(Api, "counter", (handlers) =>
  handlers
    .handle("page", counterPage)
    .pipe(LiveComponent.handle(Counter))).pipe(Layer.provide(CounterHandlers))

const makeApp = () => HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/", Effect.sync(() =>
      Html.response(<CounterView state={new CounterState({ count: 1, label: "Clicks" })} />))),
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(CounterLayer),
      Layer.provide(GateLive),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer))
    )
  ).pipe(
    // Pages and actions sign with the same key, as when it is provided to HttpRouter.serve
    Layer.provideMerge(LiveComponent.secret(Redacted.make("test secret")))
  ),
  { disableLogger: true }
)

// Type checks -------------------------------------------------------------------

export const typeChecks = () => [
  // @ts-expect-error the view takes the state
  <CounterView count={1} />,
  LiveComponent.view(Counter, {
    render: (_state, actions) => (
      <>
        {/* @ts-expect-error by is a number */}
        <button {...actions.add({ by: "5" })} />
        {/* @ts-expect-error there is no such action */}
        <button {...actions.remove()} />
      </>
    )
  }),
  // @ts-expect-error every action needs a handler
  LiveComponent.handlers(CounterView, {
    increment: (state) => Effect.succeed(state),
    add: (state) => Effect.succeed(state)
  }),
  LiveComponent.handlers(CounterView, {
    increment: (state) => Effect.succeed(state),
    add: (state) => Effect.succeed(state),
    // @ts-expect-error a handler returns the next state
    rename: () => Effect.succeed({ count: 1 })
  }),
  // Without the component's handlers, the group's layer still requires them
  HttpRouter.toWebHandler(
    // @ts-expect-error LiveComponent.Handlers<"test-counter"> is not provided
    HttpApiBuilder.layer(Api).pipe(Layer.provide(
      HttpApiBuilder.group(Api, "counter", (handlers) =>
        handlers.handle("page", counterPage).pipe(LiveComponent.handle(Counter)))
    ))
  ),
  // Without handling the component, its actions are unhandled endpoints
  // @ts-expect-error the group's handlers must handle every endpoint
  HttpApiBuilder.group(Api, "counter", (handlers) => handlers.handle("page", counterPage))
]

// Tests -------------------------------------------------------------------------

const stateOf = (body: string) => body.match(/name="effect-views-state" value="([^"]+)"/)![1]!

const post = async (
  handler: (request: Request) => Promise<Response>,
  path: string,
  values: Record<string, string>,
  headers: Record<string, string> = { "x-allowed": "yes" }
) => {
  const response = await handler(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true", ...headers },
    body: new URLSearchParams(values)
  }))
  return { status: response.status, body: await response.text() }
}

Vitest.describe("LiveComponent", () => {
  Vitest.it("renders its state, signed, and actions as htmx attributes", async () => {
    const { dispose, handler } = makeApp()
    try {
      const body = await (await handler(new Request("http://localhost/"))).text()
      Vitest.expect(body).toMatch(/^<test-counter data-component><input type="hidden" name="effect-views-state" value="[\w-]+\.[\w-]+">/)
      Vitest.expect(body).toContain("<output>Clicks: 1</output>")
      Vitest.expect(body).toContain(
        `<button type="button" hx-post="/live/test-counter/increment" hx-include="closest test-counter" hx-target="closest test-counter" hx-swap="outerHTML">+</button>`
      )
      Vitest.expect(body).toContain(`hx-vals="{&quot;by&quot;:&quot;5&quot;}"`)
    } finally {
      await dispose()
    }
  })

  Vitest.it("runs actions as HttpApi endpoints and renders the component again", async () => {
    const { dispose, handler } = makeApp()
    try {
      const page = await (await handler(new Request("http://localhost/"))).text()

      // The handler uses a service from the application
      const incremented = await post(handler, "/live/test-counter/increment", { "effect-views-state": stateOf(page) })
      Vitest.expect(incremented.status).toBe(200)
      Vitest.expect(incremented.body).toContain("<output>Clicks: 3</output>")

      // Values given where the action is used, and inputs in the component, are its payload
      const added = await post(handler, "/live/test-counter/add", { "effect-views-state": stateOf(incremented.body), by: "5" })
      Vitest.expect(added.body).toContain("<output>Clicks: 8</output>")

      const renamed = await post(handler, "/live/test-counter/rename", { "effect-views-state": stateOf(added.body), label: "Taps" })
      Vitest.expect(renamed.body).toContain("<output>Taps: 8</output>")
    } finally {
      await dispose()
    }
  })

  Vitest.it("applies the group's HttpApi middleware", async () => {
    const { dispose, handler } = makeApp()
    try {
      const state = stateOf(await (await handler(new Request("http://localhost/"))).text())
      Vitest.expect((await post(handler, "/live/test-counter/increment", { "effect-views-state": state }, {})).status).toBe(403)
    } finally {
      await dispose()
    }
  })

  Vitest.it("rejects state that is missing or was changed, and invalid payloads", async () => {
    const { dispose, handler } = makeApp()
    try {
      const state = stateOf(await (await handler(new Request("http://localhost/"))).text())
      const [data, signature] = state.split(".")
      const forged = Buffer.from(JSON.stringify({ count: 1000, label: "Clicks" })).toString("base64url")

      Vitest.expect((await post(handler, "/live/test-counter/increment", {})).status).toBe(400)
      Vitest.expect((await post(handler, "/live/test-counter/increment", { "effect-views-state": `${forged}.${signature}` })).status).toBe(400)
      Vitest.expect((await post(handler, "/live/test-counter/increment", { "effect-views-state": `${data}.x` })).status).toBe(400)
      Vitest.expect((await post(handler, "/live/test-counter/add", { "effect-views-state": state, by: "many" })).status).toBe(400)
      Vitest.expect((await post(handler, "/live/test-counter/rename", { "effect-views-state": state, label: "" })).status).toBe(400)
    } finally {
      await dispose()
    }
  })

  Vitest.it("renders without any layer, signing with a key chosen at startup", () => {
    Vitest.expect(Html.render(<CounterView state={new CounterState({ count: 1, label: "Clicks" })} />)).toContain(
      "<output>Clicks: 1</output>"
    )
  })

  Vitest.it("lists the actions with the views they belong to in the OpenAPI document", () => {
    const spec = OpenApi.fromApi(Api)
    const add = spec.paths["/live/test-counter/add"]?.post
    Vitest.expect(add?.tags).toEqual(["counter"])
    Vitest.expect(add?.operationId).toBe("counter.test-counter.add")
    Vitest.expect(add?.summary).toBe("Add to the count")
    Vitest.expect((add as Record<string, unknown> | undefined)?.["x-badges"]).toEqual([{ name: "Live", position: "before" }])
    Vitest.expect(spec.paths["/counter"]?.get?.tags).toEqual(["counter"])
  })
})
