import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"

import * as ViewHtml from "effect-views/Html"
import * as Htmx from "effect-views/Htmx"
import * as Submission from "effect-views/Submission"

import * as RootApi from "../RootApi.js"
import * as Todos from "../Todos.js"
import * as Html from "./Html.js"
import * as Todo from "../Domain/Todo.js"

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
  todos: ReadonlyArray<Todo.Todo>,
  invalid?: Submission.Invalid
) => Htmx.isRequest(request) ? Html.app(todos, invalid) : Html.page(todos, invalid)

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
          const { title } = yield* payload
          // Domain errors become messages on the form: one for the field, one for the whole form.
          yield* todos.add(title).pipe(
            Effect.catchTags({
              DuplicateTodo: () =>
                Effect.fail(new Submission.Invalid({
                  values: { title },
                  errors: { title: ["That is already on the list"] }
                })),
              TodoListFull: ({ limit }) =>
                Effect.fail(new Submission.Invalid({
                  values: { title },
                  formErrors: [`The list is full at ${limit} todos. Finish one before adding more.`]
                }))
            })
          )
          // Without htmx, redirect so that reloading the page does not submit again.
          if (!Htmx.isRequest(request)) return ViewHtml.seeOther("/")
          return Html.app(yield* todos.list)
        }).pipe(
          Effect.catchTag("FormInvalid", (invalid) =>
            Effect.map(todos.list, (items) =>
              ViewHtml.response(representation(request, items, invalid), { status: 422 })))
        ))
  })
)

export const layer = Layer.mergeAll(apiLayer, viewsLayer)
