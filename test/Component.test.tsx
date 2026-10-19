/** @jsxImportSource effect-views */

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Vitest from "vitest"

import * as Assets from "../src/Assets.js"
import * as Component from "../src/Component.js"
import { css } from "../src/Component.js"
import * as Html from "../src/Html.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"
import * as Page from "../src/Page.js"

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

const Document = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html>
    <head><Assets.Head /></head>
    <body>{children}</body>
  </html>
)
const page = Page.layout(Document)

const pages = HttpApiGroup.make("pages").add(
  HttpViewEndpoint.get("home", "/"),
  HttpViewEndpoint.get("late", "/late"),
  HttpViewEndpoint.get("app", "/app")
)

const makeApp = (options?: Assets.Options) => {
  const api = HttpApi.make("test")
    .add(pages)
    .add(Assets.groupAt((options?.prefix ?? "/assets") as `/${string}`))
  const handlers = HttpApiBuilder.group(api, "pages", (handlers) =>
    handlers
      .handle("home", ({ request }) => Effect.succeed(page(request, <><Card title="Hello">Body</Card><Plain /></>)))
      .handle("late", () =>
        Effect.sync(() => {
          const Late = Component.make("test-late", { style: css`p { color: red; }`, render: () => <p /> })
          return <Late />
        }))
      .handle("app", () => Effect.sync(() => <link rel="stylesheet" href={Assets.url("app.css")} />)))
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide([handlers, Assets.groupLayer(api)]),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer, Assets.layer(options)))
    ),
    { disableLogger: true }
  )
}

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
  Vitest.it("serves component styles and the effect-views runtime under names that change with their contents", async () => {
    const { dispose, handler } = makeApp()
    try {
      const { body } = await get(handler, "/")
      const paths = assetPaths(body)
      Vitest.expect(paths[0]).toMatch(/^\/assets\/components-[0-9a-f]{12}\.css$/)
      // The runtime, and the modules it imports, preloaded
      const runtime = /<script type="module" src="(\/assets\/start-[0-9a-f]{12}\.js)"><\/script>/.exec(body)?.[1]
      Vitest.expect(runtime).toBeDefined()
      Vitest.expect(body).toMatch(/<link rel="modulepreload" href="\/assets\/runtime-[0-9a-f]{12}\.js">/)

      const styles = await get(handler, paths[0]!)
      Vitest.expect(styles.status).toBe(200)
      Vitest.expect(styles.headers.get("content-type")).toBe("text/css; charset=utf-8")
      Vitest.expect(styles.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      Vitest.expect(styles.body).toContain("@scope (test-card) to (:scope [data-component]) {")
      Vitest.expect(styles.body).toContain("h2 { margin: 0; }")

      const script = await get(handler, runtime!)
      Vitest.expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      Vitest.expect(script.body).toMatch(/import"\/assets\/[^"]+"|from"\/assets\/[^"]+"/)

      Vitest.expect((await get(handler, "/assets/missing.js")).status).toBe(404)
    } finally {
      await dispose()
    }
  })

  Vitest.it("serves the files under another prefix", async () => {
    const { dispose, handler } = makeApp({ prefix: "/static" })
    try {
      const paths = assetPaths((await get(handler, "/")).body)
      Vitest.expect(paths.length).toBeGreaterThan(1)
      for (const path of paths) Vitest.expect(path).toMatch(/^\/static\//)
      Vitest.expect((await get(handler, paths[0]!)).status).toBe(200)
    } finally {
      await dispose()
    }
  })

  Vitest.it("serves the application's own files, under names that change with their contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effect-views-assets-"))
    await writeFile(join(directory, "app.css"), "body { margin: 0; }")
    const { dispose, handler } = makeApp({ files: { "app.css": join(directory, "app.css") } })
    try {
      const [path] = assetPaths((await get(handler, "/app")).body)
      Vitest.expect(path).toMatch(/^\/assets\/app-[0-9a-f]{12}\.css$/)
      const file = await get(handler, path!)
      Vitest.expect(file.headers.get("content-type")).toBe("text/css; charset=utf-8")
      Vitest.expect(file.body).toBe("body { margin: 0; }")
    } finally {
      await dispose()
    }
  })

  Vitest.it("refuses an assets group at another prefix than the files", async () => {
    const api = HttpApi.make("test").add(Assets.groupAt("/static"))
    const { dispose, handler } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(api).pipe(
        Layer.provide(Assets.groupLayer(api)),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer, Assets.layer()))
      ),
      { disableLogger: true }
    )
    try {
      await Vitest.expect(handler(new Request("http://localhost/static/x"))).rejects.toThrow(/Assets.groupAt\("\/assets"\)/)
    } finally {
      await dispose().catch(() => undefined)
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
