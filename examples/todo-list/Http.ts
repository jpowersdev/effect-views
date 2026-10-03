import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { createServer } from "node:http"

import * as Csrf from "effect-views/Csrf"
import * as Htmx from "effect-views/Htmx"

import * as RootApi from "./RootApi.js"
import * as Todos from "./Todos.js"
import * as TodosHttp from "./Todos/Http.js"

const apiRoutes = HttpApiBuilder.layer(RootApi.Api).pipe(
  Layer.provide(TodosHttp.layer)
)

export const routes = Layer.mergeAll(
  apiRoutes,
  Htmx.varyLayer,
  Csrf.layer()
).pipe(
  Layer.provide(Todos.layer)
)

const port = Number(process.env["PORT"] ?? 3000)
const filename = process.env["TODOS_DB"] ?? "todos.sqlite"

export const layer = routes.pipe(
  HttpRouter.serve,
  Layer.provide(SqliteClient.layer({ filename })),
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }))
)
