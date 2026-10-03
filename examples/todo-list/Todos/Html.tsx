/** @jsxImportSource effect-views */

import * as Form from "effect-views/Form"
import * as Html from "effect-views/Html"
import * as Htmx from "effect-views/Htmx"
import type * as Submission from "effect-views/Submission"

import type * as Todo from "../Domain/Todo.js"
import * as Views from "./Views.js"

export const NewTodo = Form.derive({
  id: "new-todo",
  endpoint: Views.create
})

const TodoList = ({ todos }: { readonly todos: ReadonlyArray<Todo.Todo> }): Html.Html => (
  <ul>
    {todos.map((todo) => <li key={todo.id}>{todo.title}</li>)}
  </ul>
)

interface TodoAppProps {
  readonly todos: ReadonlyArray<Todo.Todo>
  readonly invalid?: Submission.Invalid | undefined
}

const TodoApp = ({ invalid, todos }: TodoAppProps): Html.Html => {
  const Form = NewTodo.with(invalid)
  return (
    <main id="todo-app">
      <h1>Todo list</h1>
      <TodoList todos={todos} />
      <Form.Root
        hx-boost="true"
        hx-push-url="false"
        hx-target="#todo-app"
        hx-swap="outerHTML"
      >
        <Form.Error role="alert" class="error" />
        <div class={Form.hasErrors("title") ? "field field--invalid" : "field"}>
          <Form.Label name="title">What needs doing?</Form.Label>
          <Form.Input
            name="title"
            type="text"
            autocomplete="off"
            required
          />
          <Form.Error name="title" class="error" />
        </div>
        <button type="submit">Add todo</button>
      </Form.Root>
    </main>
  )
}

const styles = `
  .error { color: #b3261e; margin: 0.25rem 0; }
  .field--invalid input { border: 2px solid #b3261e; }
`

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Effect Views Todo List</title>
      <Htmx.Config />
      <style>{Html.unsafe(styles)}</style>
      <script src="https://unpkg.com/htmx.org@2.0.8"></script>
    </head>
    <body>{children}</body>
  </html>
)

export const app = (todos: ReadonlyArray<Todo.Todo>, invalid?: Submission.Invalid): Html.Html =>
  <TodoApp todos={todos} invalid={invalid} />

export const page = (todos: ReadonlyArray<Todo.Todo>, invalid?: Submission.Invalid): Html.Html =>
  <Page><TodoApp todos={todos} invalid={invalid} /></Page>
