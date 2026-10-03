import * as HttpApi from "effect/http-api/HttpApi"

import * as TodosApi from "./Todos/Api.js"

/** JSON routes, declared separately from their handlers. */
export const Api = HttpApi.make("DataApi")
  .add(TodosApi.group)
  .prefix("/api")
