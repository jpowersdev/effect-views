#!/usr/bin/env node

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import { createServer } from "node:http"

import * as Assets from "effect-views/Assets"
import * as Csrf from "effect-views/Csrf"
import * as Page from "effect-views/Page"
import * as App from "./App.js"

const port = Number(process.env["PORT"] ?? 3000)

const main = Layer.mergeAll(App.routes, App.errorPages, Page.varyLayer, Csrf.layer()).pipe(
  HttpRouter.serve,
  // The effect-views runtime, with the live components that run in the browser
  Layer.provide(Assets.layer({ api: App.api })),
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }))
)

Layer.launch(main).pipe(NodeRuntime.runMain)
