import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiScalar from "effect/http-api/HttpApiScalar"
import { createServer } from "node:http"

import * as Assets from "effect-views/Assets"
import * as Csrf from "effect-views/Csrf"
import * as Htmx from "effect-views/Htmx"

import * as RootApi from "./RootApi.js"
import * as TodosHttp from "./Todos/Http.js"

const ApiRoutes = HttpApiBuilder.layer(RootApi.Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([TodosHttp.TodosApiLayer, TodosHttp.TodosViewsLayer])
)

const DocsRoute = HttpApiScalar.layer(RootApi.Api, { path: "/docs" })

export const Routes = Layer.mergeAll(
  ApiRoutes,
  DocsRoute,
  Assets.routes,
  Htmx.varyLayer,
  Csrf.layer()
)

/** htmx, its sse extension, and the styles of every component defined by the modules above. */
export const AssetsLayer = Assets.layer({ extensions: ["sse"] })

const host = process.env["HOST"] ?? "127.0.0.1"
const port = Number(process.env["PORT"] ?? 3000)
const filename = process.env["TODOS_DB"] ?? "todos.sqlite"

export const HttpLayer = HttpRouter.serve(Routes).pipe(
  Layer.provide(AssetsLayer),
  Layer.provide(SqliteClient.layer({ filename })),
  Layer.provide(NodeHttpServer.layer(createServer, { host, port }))
)
