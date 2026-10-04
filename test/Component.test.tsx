/** @jsxImportSource effect-views */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Vitest from "vitest"

import * as Assets from "../src/Assets.js"
import * as Component from "../src/Component.js"
import { css } from "../src/Component.js"
import * as Html from "../src/Html.js"
import * as Htmx from "../src/Htmx.js"

const Card = Component.make("test-card", {
  style: css`
    :scope { display: block; }
    h2 { margin: 0; }
  `,
  render: ({ title, children }: { title: string; children: Html.Child }) => <><h2>{title}</h2>{children}</>
})

const Plain = Component.make("test-plain", {
  render: () => <p>Hi</p>
})

// Props are checked like any component's
export const typeChecks = () => [
  // @ts-expect-error title is required
  <Card>Body</Card>,
  // @ts-expect-error title must be a string
  <Card title={1}>Body</Card>
]

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html>
    <head><Assets.Head /></head>
    <body>{children}</body>
  </html>
)
const page = Htmx.layout(Page)

const makeApp = (options?: Assets.Options) => HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return Html.response(page(request, <><Card title="Hello">Body</Card><Plain /></>))
    })),
    HttpRouter.add("GET", "/late", Effect.sync(() => {
      const Late = Component.make("test-late", { style: css`p { color: red; }`, render: () => <p /> })
      return Html.response(<Late />)
    })),
    Assets.routes
  ).pipe(Layer.provide(Assets.layer(options))),
  { disableLogger: true }
)

const get = async (handler: (request: Request) => Promise<Response>, path: string) => {
  const response = await handler(new Request(`http://localhost${path}`))
  return { status: response.status, headers: response.headers, body: await response.text() }
}

const assetPaths = (body: string) => [...body.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((match) => match[1]!)

Vitest.describe("Component.make", () => {
  Vitest.it("renders its markup inside a custom element", () => {
    Vitest.expect(Html.render(<Card title="Hello">Body</Card>)).toBe(
      `<test-card data-component><h2>Hello</h2>Body</test-card>`
    )
  })

  Vitest.it("rejects tags that are not custom element names, or already taken", () => {
    Vitest.expect(() => Component.make("card", { render: () => <p /> })).toThrow(/custom element name/)
    Vitest.expect(() => Component.make("test-card", { render: () => <p /> })).toThrow(/already defined/)
  })
})

Vitest.describe("Assets.layer", () => {
  Vitest.it("serves htmx and component styles under names that change with their contents", async () => {
    const { dispose, handler } = makeApp()
    try {
      const { body } = await get(handler, "/")
      const paths = assetPaths(body)
      Vitest.expect(paths).toEqual([
        Vitest.expect.stringMatching(/^\/assets\/components-[0-9a-f]{12}\.css$/),
        Vitest.expect.stringMatching(/^\/assets\/htmx-[0-9a-f]{12}\.js$/)
      ])
      Vitest.expect(body).toContain(`<script src="${paths[1]}" defer></script>`)

      const styles = await get(handler, paths[0]!)
      Vitest.expect(styles.status).toBe(200)
      Vitest.expect(styles.headers.get("content-type")).toBe("text/css; charset=utf-8")
      Vitest.expect(styles.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      Vitest.expect(styles.body).toContain("@scope (test-card) to (:scope [data-component]) {")
      Vitest.expect(styles.body).toContain("h2 { margin: 0; }")

      const htmx = await get(handler, paths[1]!)
      Vitest.expect(htmx.body).toContain("htmx")

      Vitest.expect((await get(handler, "/assets/missing.js")).status).toBe(404)
    } finally {
      await dispose()
    }
  })

  Vitest.it("serves htmx extensions after htmx", async () => {
    const { dispose, handler } = makeApp({ extensions: ["sse"] })
    try {
      const paths = assetPaths((await get(handler, "/")).body)
      Vitest.expect(paths.slice(1)).toEqual([
        Vitest.expect.stringMatching(/^\/assets\/htmx-[0-9a-f]{12}\.js$/),
        Vitest.expect.stringMatching(/^\/assets\/htmx-ext-sse-[0-9a-f]{12}\.js$/)
      ])
      Vitest.expect((await get(handler, paths[2]!)).body).toContain(`defineExtension("sse"`)
    } finally {
      await dispose()
    }
  })

  Vitest.it("loads htmx from elsewhere, or leaves it out", async () => {
    const elsewhere = makeApp({ htmx: { url: "https://cdn.example/htmx.min.js" }, prefix: "/static" })
    const without = makeApp({ htmx: false })
    try {
      const body = (await get(elsewhere.handler, "/")).body
      Vitest.expect(assetPaths(body)[0]).toMatch(/^\/static\/components-/)
      Vitest.expect(body).toContain(`src="https://cdn.example/htmx.min.js"`)
      Vitest.expect((await get(without.handler, "/")).body).not.toContain("htmx")
    } finally {
      await elsewhere.dispose()
      await without.dispose()
    }
  })

  Vitest.it("refuses to render components defined after the layer was built", async () => {
    const { dispose, handler } = makeApp()
    try {
      Vitest.expect((await get(handler, "/late")).status).toBe(500)
    } finally {
      await dispose()
    }
  })
})
