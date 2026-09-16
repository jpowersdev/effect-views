#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Layer from "effect/Layer"

import * as Http from "./Http.js"

Layer.launch(Http.layer).pipe(NodeRuntime.runMain)
