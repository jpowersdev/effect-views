import * as Schema from "effect/Schema"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"

import * as HttpFormEndpoint from "effect-views/HttpFormEndpoint"
import * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"
import * as LiveAction from "effect-views/LiveAction"
import * as LiveComponent from "effect-views/LiveComponent"

import * as Todo from "../Domain/Todo.js"

export const list = HttpViewEndpoint.get("list", "/")
  .annotate(OpenApi.Summary, "The todo list")

/** The list, sent when the page connects and each time a todo is added, by any client, such as the CLI. */
export const changes = HttpViewEndpoint.events("changes", "/todos/changes")
  .annotate(OpenApi.Summary, "The list as it changes")

export const create = HttpFormEndpoint.make("create", "/todos", {
  payload: Todo.CreateTodo,
  annotations: OpenApi.annotations({ summary: "Add a todo, with the form" })
})

/** What the search renders from: what was typed, and the todos that match it. */
export class SearchState extends Schema.Class<SearchState>("SearchState")({
  query: Schema.String,
  matches: Schema.Array(Todo.Todo)
}) {
  static readonly empty = new SearchState({ query: "", matches: [] })
}

/** Runs as you type. An empty search input is not submitted at all. */
export const search = LiveAction.make("search", {
  payload: { query: Schema.optionalKey(Schema.String) },
  description: "Search todos"
})

/** Searches the list as you type; see Search.tsx and Http.ts. */
export const Search = LiveComponent.make("todo-search", { state: SearchState })
  .add(search)

/** The todos' pages, fragments, and live components; listed as "Todos" under "Views". */
export const group = HttpApiGroup.make("todosViews")
  .add(list, changes, create)
  .add(...LiveComponent.endpoints(Search))
  .annotate(OpenApi.Override, { "x-displayName": "Todos" })
  .annotate(OpenApi.Description, "The todo list's pages, the fragments htmx swaps in, and its live components.")
