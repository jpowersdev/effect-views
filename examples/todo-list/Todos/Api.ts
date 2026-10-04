import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"

import * as Todo from "../Domain/Todo.js"

export const group = HttpApiGroup.make("todosApi")
  .add(
    HttpApiEndpoint.get("list", "/todos", {
      success: Schema.Array(Todo.Todo)
    }).annotate(OpenApi.Summary, "List todos")
  )
  .add(
    HttpApiEndpoint.post("create", "/todos", {
      payload: Todo.CreateTodo,
      success: Todo.Todo,
      // Named for the document as they are sent, rather than "DuplicateTodoEncoded"
      error: [
        Todo.DuplicateTodo.pipe(Schema.annotateEncoded({ identifier: "DuplicateTodo" })),
        Todo.TodoListFull.pipe(Schema.annotateEncoded({ identifier: "TodoListFull" }))
      ]
    }).annotate(OpenApi.Summary, "Add a todo")
  )
  // Listed as "Todos" under "API"
  .annotate(OpenApi.Override, { "x-displayName": "Todos" })
  .annotate(OpenApi.Description, "The todo list as JSON, for programs such as the CLI.")
