/** @jsxImportSource effect-views */

import * as Assets from "effect-views/Assets"
import * as Form from "effect-views/Form"
import * as Html from "effect-views/Html"
import type * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"
import * as Page from "effect-views/Page"
import type * as Submission from "effect-views/Submission"
import * as View from "effect-views/View"

import type * as Todo from "../Domain/Todo.js"
import * as Search from "./Search.js"
import * as TitleField from "./TitleField.js"
import * as Views from "./Views.js"

export const NewTodo = Form.derive({
  id: "new-todo",
  endpoint: Views.create
})

const Changes = View.derive({ endpoint: Views.changes })

const TodoList = ({ todos }: { readonly todos: ReadonlyArray<Todo.Todo> }): Html.Html => (
  <ul>
    {todos.map((todo) => <li key={todo.id}>{todo.title}</li>)}
  </ul>
)

/** The list, as an event that replaces it in every open page. */
export const listChanged = (todos: ReadonlyArray<Todo.Todo>): HttpViewEndpoint.HtmlEvent => ({
  event: "todos",
  data: <TodoList todos={todos} />
})

interface TodoAppProps {
  readonly todos: ReadonlyArray<Todo.Todo>
  readonly invalid?: Submission.Invalid | undefined
}

const TodoApp = ({ invalid, todos }: TodoAppProps): Html.Html => {
  const Form = NewTodo.with(invalid)
  return (
    <main id="todo-app">
      <h1>Todo list</h1>
      {/* Shows todos added anywhere, such as with the CLI, as they are added */}
      <Changes.Subscribe event="todos">
        <TodoList todos={todos} />
      </Changes.Subscribe>
      <Search.View state={Views.SearchState.empty} />
      <Form.Root target="#todo-app">
        <Form.Error role="alert" class="error" />
        {/* Runs in the browser: checks the title as you type, and still submits with the form */}
        <TitleField.View state={TitleField.stateFor(invalid)} />
        <button type="submit">Add todo</button>
      </Form.Root>
    </main>
  )
}

const styles = `
  .error { color: #b3261e; margin: 0.25rem 0; }
  input:focus { outline: 3px solid #2f5bd3; outline-offset: 2px; }
`

const Document = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Effect Views Todo List</title>
      <style>{Html.unsafe(styles)}</style>
      <Assets.Head />
    </head>
    <body>{children}</body>
  </html>
)

export const app = (todos: ReadonlyArray<Todo.Todo>, invalid?: Submission.Invalid): Html.Html =>
  <TodoApp todos={todos} invalid={invalid} />

/** Views on their own for the runtime, inside the page for everything else */
export const page = Page.layout(Document)
