import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"

import * as Todo from "../Domain/Todo.js"

export const group = HttpApiGroup.make("todosApi")
  .add(
    HttpApiEndpoint.get("list", "/todos", {
      success: Schema.Array(Todo.Todo)
    })
  )
  .add(
    HttpApiEndpoint.post("create", "/todos", {
      payload: Todo.CreateTodo,
      success: Todo.Todo,
      error: Todo.DuplicateTodo
    })
  )
