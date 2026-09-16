import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"

import type * as Todo from "./Domain/Todo.js"

export interface Operations {
  readonly list: Effect.Effect<ReadonlyArray<Todo.Todo>>
  readonly add: (title: string) => Effect.Effect<Todo.Todo>
}

/** Domain service and entrypoint for the adjacent Todos/ modules. */
export class Todos extends Context.Service<Todos, Operations>()("examples/Todos") {}

export const layer = Layer.effect(
  Todos,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<Todo.Todo>>([
      { id: 1, title: "Try Effect views" },
      { id: 2, title: "Build a hypermedia application" }
    ])

    return Todos.of({
      list: Ref.get(state),
      add: (title) => Ref.modify(state, (todos) => {
        const todo: Todo.Todo = {
          id: (todos.at(-1)?.id ?? 0) + 1,
          title
        }
        return [todo, [...todos, todo]]
      })
    })
  })
)
