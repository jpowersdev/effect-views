import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import * as Htmx from "effect-views/Htmx"

import * as RootApi from "../RootApi.js"
import * as Todos from "../Todos.js"
import * as Html from "./Html.js"
import type * as Todo from "../Domain/Todo.js"

export const apiLayer = HttpApiBuilder.group(
  RootApi.Api,
  "todosApi",
  Effect.fnUntraced(function* (handlers) {
    const todos = yield* Todos.Todos

    return handlers
      .handle("list", () => todos.list)
      .handle("create", ({ payload }) => todos.add(payload.title))
  })
)

const representation = (
  request: Parameters<typeof Htmx.isRequest>[0],
  todos: ReadonlyArray<Todo.Todo>
) => Htmx.isRequest(request) ? Html.app(todos) : Html.page(todos)

export const viewsLayer = HttpApiBuilder.group(
  RootApi.Api,
  "todosViews",
  Effect.fnUntraced(function* (handlers) {
    const todos = yield* Todos.Todos

    return handlers
      .handle("list", ({ request }) =>
        Effect.map(todos.list, (items) => representation(request, items)))
      .handle("create", ({ payload, request }) =>
        Effect.gen(function* () {
          yield* todos.add(payload.title)
          const items = yield* todos.list
          return representation(request, items)
        }))
  })
)

export const layer = Layer.mergeAll(apiLayer, viewsLayer)
