import * as HttpApi from "effect/http-api/HttpApi"
import * as OpenApi from "effect/http-api/OpenApi"

import * as DataApi from "./DataApi.js"
import * as Views from "./Views.js"

/** Combines the example's JSON and HTML routes. */
export const Api = HttpApi.make("RootApi")
  .addHttpApi(DataApi.Api)
  .addHttpApi(Views.Api)
  .annotate(OpenApi.Title, "Todo list")
  // Sections of the reference page: the HTML for people, and the JSON for programs
  .annotate(OpenApi.Override, {
    "x-tagGroups": [
      { name: "Views", tags: ["todosViews"] },
      { name: "API", tags: ["todosApi"] }
    ]
  })
