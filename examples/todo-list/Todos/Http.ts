import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"

import * as ViewHtml from "effect-views/Html"
import * as Htmx from "effect-views/Htmx"
import * as LiveComponent from "effect-views/LiveComponent"

import * as RootApi from "../RootApi.js"
import * as Todos from "../Todos.js"
import * as Html from "./Html.js"
import * as Search from "./Search.js"
import * as Views from "./Views.js"

/** The JSON API for todos. */
export const TodosApiLayer = HttpApiBuilder.group(
  RootApi.Api,
  "todosApi",
  Effect.fnUntraced(function* (handlers) {
    const todos = yield* Todos.Todos

    return handlers
      .handle("list", () => todos.list)
      .handle("create", ({ payload }) => todos.add(payload.title))
  })
).pipe(Layer.provide(Todos.layer))

/** The search action: the todos that match what was typed. */
export const SearchHandlers = LiveComponent.handlers(Search.View, {
  search: (_state, { query = "" }) =>
    Effect.gen(function* () {
      const todos = yield* Todos.Todos
      const matches = query.trim() === "" ? [] : yield* todos.search(query.trim())
      return new Views.SearchState({ query, matches })
    })
}).pipe(Layer.provide(Todos.layer))

/** The pages, fragments, and live components for todos. */
export const TodosViewsLayer = HttpApiBuilder.group(
  RootApi.Api,
  "todosViews",
  Effect.fnUntraced(function* (handlers) {
    const todos = yield* Todos.Todos

    return yield* handlers
      .handle("list", ({ request }) =>
        Effect.map(todos.list, (items) => Html.page(request, Html.app(items))))
      .handle("changes", () => Effect.succeed(Stream.map(todos.changes, Html.listChanged)))
      .handle("create", ({ payload, request }) =>
        Effect.gen(function* () {
          const { title } = yield* payload
          // Domain errors become messages on the form: one for the field, one for the whole form.
          yield* todos.add(title).pipe(
            Effect.catchTags({
              DuplicateTodo: () =>
                Effect.fail(Html.NewTodo.reject({ title }, {
                  errors: { title: ["That is already on the list"] }
                })),
              TodoListFull: ({ limit }) =>
                Effect.fail(Html.NewTodo.reject({ title }, {
                  formErrors: [`The list is full at ${limit} todos. Finish one before adding more.`]
                }))
            })
          )
          // When a page is expected, redirect so that reloading it does not submit again.
          if (!Htmx.wantsFragment(request)) return ViewHtml.seeOther("/")
          return Html.app(yield* todos.list)
        }).pipe(
          Effect.catchTag("FormInvalid", (invalid) =>
            Effect.map(todos.list, (items) =>
              Html.page(request, Html.app(items, invalid), { status: 422 })))
        ))
      .pipe(LiveComponent.handle(Views.Search))
  })
).pipe(Layer.provide([Todos.layer, SearchHandlers]))
