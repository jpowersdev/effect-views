import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { createServer } from "node:http"

import * as Htmx from "effect-views/Htmx"

import * as RootApi from "./RootApi.js"
import * as Todos from "./Todos.js"
import * as TodosHttp from "./Todos/Http.js"

const apiRoutes = HttpApiBuilder.layer(RootApi.Api).pipe(
  Layer.provide(TodosHttp.layer)
)

export const routes = Layer.mergeAll(
  apiRoutes,
  Htmx.varyLayer
).pipe(
  Layer.provide(Todos.layer)
)

export const layer = routes.pipe(
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 3001 }))
)
