#!/usr/bin/env node

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { createServer } from "node:http"

import * as Htmx from "effect-views/Htmx"
import * as App from "./App.js"

const port = Number(process.env["PORT"] ?? 3000)

const main = Layer.mergeAll(App.routes, Htmx.varyLayer).pipe(
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }))
)

Layer.launch(main).pipe(NodeRuntime.runMain)
