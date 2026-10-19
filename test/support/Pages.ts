// Serves the effect-views runtime, bundled from src/client/start.ts by
// effect-views' own bundler, with hand-written pages and routes: for browser
// tests of what the runtime does with the attributes and headers in Protocol,
// without an application around it.
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"

import * as Bundler from "../../src/internal/Bundler.js"
import * as Serve from "./Serve.js"

const entry = fileURLToPath(new URL("../../src/client/start.ts", import.meta.url))

export type Route = (request: Request) => Response | Promise<Response>

export interface Pages extends Serve.Served {
  /** Answers requests for a path, by any method and with any query, in place of what answered them before. */
  readonly route: (path: string, route: Route) => void
  /**
   * Serves a page at the path that loads the runtime: `body` is the body's
   * HTML, and `head` anything else for its head. Once the runtime has
   * started, `window.started` is the time it did, by Date.now().
   */
  readonly page: (path: string, body: string, head?: string) => void
}

/** An attribute whose value is JSON, as the runtime reads them, escaped for HTML. */
export const json = (name: string, value: unknown): string =>
  `${name}="${JSON.stringify(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;")}"`

/** An HTML response, as a route answers the runtime. */
export const html = (body: string, status = 200, headers: Readonly<Record<string, string>> = {}): Response =>
  new Response(status === 204 ? null : body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } })

export const serve = async (): Promise<Pages> => {
  const bundle = await Effect.runPromise(Bundler.bundle({ entries: [entry], prefix: "/assets" }))
  const runtime = bundle.entries.get(entry)!
  const routes = new Map<string, Route>()
  for (const file of bundle.files) {
    routes.set(file.path, () => new Response(new Uint8Array(file.body), { headers: { "content-type": file.contentType } }))
  }
  const served = await Serve.serve(async (request) => {
    const route = routes.get(new URL(request.url).pathname)
    return route === undefined ? new Response("Not found", { status: 404 }) : route(request)
  })
  return {
    ...served,
    route: (path, route) => {
      routes.set(path, route)
    },
    page: (path, body, head = "") => {
      const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">${head}` +
        `<script type="module">import "${runtime}"; window.started = Date.now()</script></head><body>${body}</body></html>`
      routes.set(path, () => html(document))
    }
  }
}
