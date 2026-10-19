import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Zlib from "node:zlib"
import * as Vitest from "vitest"

import * as Assets from "../src/Assets.js"

const Api = HttpApi.make("test").add(Assets.group)

/**
 * Fetches htmx, which Assets.layer serves by default, accepting the given
 * codings. The files' names come from their contents, so building the assets
 * again gives the same path to ask for.
 */
const fetchHtmx = async (options: Assets.Options | undefined, acceptEncoding?: string) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(Assets.groupLayer(Api)),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer, Assets.layer(options)))
    ),
    { disableLogger: true }
  )
  try {
    const built = await Effect.runPromise(Assets.make(options))
    const path = built.scripts[0]!
    const response = await handler(new Request(`http://localhost${path}`, {
      headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }
    }))
    return {
      encoding: response.headers.get("content-encoding"),
      vary: response.headers.get("vary"),
      body: new Uint8Array(await response.arrayBuffer()),
      // As a plain Uint8Array, to compare bytes rather than kinds of array
      original: new Uint8Array(built.files.get(path)!.body)
    }
  } finally {
    await dispose()
  }
}

Vitest.describe("Assets.negotiate", () => {
  Vitest.it("picks the coding the server prefers among those the request accepts", () => {
    Vitest.expect(Assets.negotiate(undefined, ["br", "gzip"])).toBeUndefined()
    Vitest.expect(Assets.negotiate("gzip, deflate, br", ["br", "gzip"])).toBe("br")
    Vitest.expect(Assets.negotiate("gzip", ["br", "gzip"])).toBe("gzip")
    Vitest.expect(Assets.negotiate("br;q=0, gzip;q=0.8", ["br", "gzip"])).toBe("gzip")
    Vitest.expect(Assets.negotiate("br;q=0, *", ["br", "gzip"])).toBe("gzip")
    Vitest.expect(Assets.negotiate("*;q=0.5", ["br", "gzip"])).toBe("br")
    Vitest.expect(Assets.negotiate("identity", ["br", "gzip"])).toBeUndefined()
    Vitest.expect(Assets.negotiate("BR, GZIP", ["gzip"])).toBe("gzip")
    Vitest.expect(Assets.negotiate("br;q=abc", ["br"])).toBeUndefined()
  })
})

Vitest.describe("Assets.layer compression", () => {
  Vitest.it("sends files compressed with brotli or gzip, as the request accepts, and as they are otherwise", async () => {
    const br = await fetchHtmx(undefined, "gzip, deflate, br")
    Vitest.expect(br.encoding).toBe("br")
    Vitest.expect(br.vary).toBe("Accept-Encoding")
    Vitest.expect(new Uint8Array(Zlib.brotliDecompressSync(br.body))).toEqual(br.original)
    Vitest.expect(br.body.length).toBeLessThan(br.original.length / 2)

    const gzip = await fetchHtmx(undefined, "gzip")
    Vitest.expect(gzip.encoding).toBe("gzip")
    Vitest.expect(new Uint8Array(Zlib.gunzipSync(gzip.body))).toEqual(gzip.original)

    const plain = await fetchHtmx(undefined)
    Vitest.expect(plain.encoding).toBeNull()
    Vitest.expect(plain.vary).toBe("Accept-Encoding")
    Vitest.expect(plain.body).toEqual(plain.original)
  })

  Vitest.it("leaves files as they are with compress: false, such as behind a proxy that compresses them", async () => {
    const result = await fetchHtmx({ compress: false }, "br")
    Vitest.expect(result.encoding).toBeNull()
    Vitest.expect(result.vary).toBeNull()
    Vitest.expect(result.body).toEqual(result.original)
  })
})
