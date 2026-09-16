/** @jsxImportSource effect-views */

import * as Form from "effect-views/Form"
import * as Html from "effect-views/Html"

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

const TodoApp = ({ todos }: { readonly todos: ReadonlyArray<Todo.Todo> }): Html.Html => (
  <main id="todo-app">
    <h1>Todo list</h1>
    <TodoList todos={todos} />
    <NewTodo.Root
      hx-boost="true"
      hx-push-url="false"
      hx-target="#todo-app"
      hx-swap="outerHTML"
    >
      <NewTodo.Label name="title">What needs doing?</NewTodo.Label>
      <NewTodo.Input
        name="title"
        type="text"
        autocomplete="off"
        required
      />
      <button type="submit">Add todo</button>
    </NewTodo.Root>
  </main>
)

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Effect Views Todo List</title>
      <script src="https://unpkg.com/htmx.org@2.0.8"></script>
    </head>
    <body>{children}</body>
  </html>
)

export const app = (todos: ReadonlyArray<Todo.Todo>): Html.Html =>
  <TodoApp todos={todos} />

export const page = (todos: ReadonlyArray<Todo.Todo>): Html.Html =>
  <Page><TodoApp todos={todos} /></Page>
