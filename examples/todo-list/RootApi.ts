import * as HttpApi from "effect/unstable/httpapi/HttpApi"

import * as DataApi from "./DataApi.js"
import * as Views from "./Views.js"

/** Combines the example's JSON and HTML routes. */
export const Api = HttpApi.make("RootApi")
  .addHttpApi(DataApi.Api)
  .addHttpApi(Views.Api)
