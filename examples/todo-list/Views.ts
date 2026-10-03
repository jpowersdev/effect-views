import * as HttpApi from "effect/http-api/HttpApi"

import * as TodosViews from "./Todos/Views.js"

/** HTML routes, declared separately from their handlers. */
export const Api = HttpApi.make("Views")
  .add(TodosViews.group)
