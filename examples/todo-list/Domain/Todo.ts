import * as Schema from "effect/Schema"

export const Todo = Schema.Struct({
  id: Schema.Int,
  title: Schema.NonEmptyString
})
export type Todo = typeof Todo.Type

export const CreateTodo = Schema.Struct({
  title: Schema.NonEmptyString
})
export type CreateTodo = typeof CreateTodo.Type

export class DuplicateTodo extends Schema.TaggedError<DuplicateTodo>()("DuplicateTodo", {
  title: Schema.String
}, { httpApiStatus: 409 }) {}
