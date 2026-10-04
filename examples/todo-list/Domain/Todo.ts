import * as Schema from "effect/Schema"

export const maxTodos = 10
export const maxTitleLength = 80

// Identifiers name schemas in the OpenAPI document
export const Todo = Schema.Struct({
  id: Schema.Int,
  title: Schema.NonEmptyString
}).annotate({ identifier: "Todo" })
export type Todo = typeof Todo.Type

/**
 * A new todo's title, with messages written for the person filling in the form.
 * `messageMissingKey` covers an empty input, which forms submit as missing.
 */
export const Title = Schema.Trim.check(
  Schema.isMinLength(1, { message: "Write what needs doing" }),
  Schema.isMaxLength(maxTitleLength, { message: `Keep it under ${maxTitleLength} characters` })
).annotateKey({ messageMissingKey: "Write what needs doing" })

export const CreateTodo = Schema.Struct({
  title: Title
}).annotate({ identifier: "CreateTodo" })
export type CreateTodo = typeof CreateTodo.Type

export class DuplicateTodo extends Schema.TaggedError<DuplicateTodo>()("DuplicateTodo", {
  title: Schema.String
}, { httpApiStatus: 409 }) {}

export class TodoListFull extends Schema.TaggedError<TodoListFull>()("TodoListFull", {
  limit: Schema.Int
}, { httpApiStatus: 409 }) {}
