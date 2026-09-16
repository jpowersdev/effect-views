import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import * as HttpFormEndpoint from "effect-views/HttpFormEndpoint"
import * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"

import * as Todo from "../Domain/Todo.js"

export const list = HttpViewEndpoint.get("list", "/")

export const create = HttpFormEndpoint.make("create", "/todos", {
  payload: Todo.CreateTodo
})

export const group = HttpApiGroup.make("todosViews")
  .add(list)
  .add(create)
