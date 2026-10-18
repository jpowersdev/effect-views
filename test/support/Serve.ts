// Serves a web handler, or a few files, over HTTP on a free port, for the
// browser tests to load.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface Served {
  readonly url: string
  /** Requests received, by method and path, in order. */
  readonly requests: ReadonlyArray<string>
  readonly close: () => Promise<void>
}

const body = (request: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Uint8Array> = []
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
    request.on("error", reject)
  })

/** Serves a web handler, such as the one HttpRouter.toWebHandler makes. */
export const serve = async (handler: (request: Request) => Promise<Response>): Promise<Served> => {
  const requests: Array<string> = []
  const server: Server = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    requests.push(`${incoming.method} ${incoming.url}`)
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value)
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      }
      const method = incoming.method ?? "GET"
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: await body(incoming) })
      })
      const response = await handler(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      outgoing.writeHead(500)
      outgoing.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** Serves files from memory, by path, with their content types. */
export const serveFiles = (files: ReadonlyMap<string, { readonly contentType: string; readonly body: Uint8Array | string }>) =>
  serve(async (request) => {
    const file = files.get(new URL(request.url).pathname)
    return file === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(typeof file.body === "string" ? file.body : new Uint8Array(file.body), {
        headers: { "content-type": file.contentType }
      })
  })
