import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlSchema from "effect/sql/SqlSchema"

import * as Todo from "./Domain/Todo.js"

export interface Operations {
  readonly list: Effect.Effect<ReadonlyArray<Todo.Todo>>
  readonly add: (title: string) => Effect.Effect<Todo.Todo, Todo.DuplicateTodo | Todo.TodoListFull>
}

/** Domain service and entrypoint for the adjacent Todos/ modules. */
export class Todos extends Context.Service<Todos, Operations>()("examples/Todos") {}

/** Stores todos with whichever SqlClient is provided, such as SQLite. */
export const layer = Layer.effect(
  Todos,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL UNIQUE
      )
    `
    yield* sql`
      INSERT INTO todos (title)
      SELECT title FROM (
        SELECT 1 AS position, 'Try Effect views' AS title
        UNION ALL SELECT 2, 'Build a hypermedia application'
      )
      WHERE NOT EXISTS (SELECT 1 FROM todos)
      ORDER BY position
    `

    const list = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Todo.Todo,
      execute: () => sql`SELECT id, title FROM todos ORDER BY id`
    })

    const count = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.Int }),
      execute: () => sql`SELECT count(*) AS count FROM todos`
    })

    const insert = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Todo.Todo,
      execute: (title) => sql`
        INSERT INTO todos (title) VALUES (${title})
        ON CONFLICT (title) DO NOTHING
        RETURNING id, title
      `
    })

    // Database failures are unexpected here; they become defects and 500 responses.
    return Todos.of({
      list: Effect.orDie(list(undefined)),
      add: (title) =>
        Effect.gen(function* () {
          const current = yield* Effect.orDie(count(undefined))
          if (current.count >= Todo.maxTodos) return yield* new Todo.TodoListFull({ limit: Todo.maxTodos })
          const added = yield* Effect.orDie(insert(title))
          if (Option.isNone(added)) return yield* new Todo.DuplicateTodo({ title })
          return added.value
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", Effect.die)
        )
    })
  })
).pipe(Layer.orDie)
