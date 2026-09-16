# effect-views

An unfinished prototype for server-rendered HTML and schema-bound forms with
Effect and htmx.

## What's interesting

`effect-views` connects Effect's HTTP contracts directly to server-rendered UI:

- A tiny JSX runtime renders straight to HTML—no React, virtual DOM, or
  hydration step.
- `HttpViewEndpoint` gives Effect endpoints an HTML success schema.
- `HttpFormEndpoint` describes a URL-encoded POST with an Effect `Struct`
  schema, then `Form.derive` turns that same endpoint into typed form controls.
- Field names and compatible control types are checked by TypeScript while the
  application keeps control of its markup and layout.
- htmx helpers make it easy to return fragments, set response headers, and vary
  responses on `HX-Request`.

The examples serve full pages to ordinary browser requests and HTML fragments
to htmx requests. The same forms work with or without JavaScript.

## Try it locally

Use Node.js 22+ and pnpm 11.15.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm example:todo
# open http://127.0.0.1:3000
```

| Example | Command | Open |
| --- | --- | --- |
| [Todo list](examples/todo-list/) | `pnpm example:todo` | <http://127.0.0.1:3000> |
| [Orders](examples/orders/) | `pnpm example:orders` | <http://127.0.0.1:3000> |

Each command builds the source and starts its example on port 3000. Stop it with
Ctrl+C. Set `PORT` to use another port. Demo state is held in memory and resets
when the server restarts.

The [example walkthroughs](examples/README.md) explain what to try, where to
read the code, and how to make requests with curl.

## A schema-bound form

The form below takes its action and field names from a POST endpoint. It shows
the core relationship; the [todo example](examples/todo-list/Todos/Http.ts) adds
request handlers and chooses between full-page and fragment responses.

```tsx
/** @jsxImportSource effect-views */

import { Schema } from "effect"
import { Form, HttpFormEndpoint } from "effect-views"

export const createTodo = HttpFormEndpoint.make("create", "/todos", {
  payload: Schema.Struct({ title: Schema.NonEmptyString })
})

const NewTodo = Form.derive({ id: "new-todo", endpoint: createTodo })

export const view = (
  <NewTodo.Root hx-boost="true" hx-push-url="false">
    <NewTodo.Label name="title">What needs doing?</NewTodo.Label>
    <NewTodo.Input name="title" required />
    <button type="submit">Add todo</button>
  </NewTodo.Root>
)
```

`Root` gets `method="post"` and `action="/todos"` from the endpoint. `Label` and
`Input` share a generated ID, and the schema makes `name="title"` a typed field
reference. Layout, copy, classes, and browser validation attributes remain
ordinary JSX. The endpoint's schema also decodes the submitted payload on the
server.

`hx-push-url="false"` keeps the POST-only action out of browser history.

## JSX without React

Components are ordinary synchronous functions returning `Html`:

```tsx
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
      <NewTodo.Input name="title" required />
      <button type="submit">Add todo</button>
    </NewTodo.Root>
  </main>
)
```

TypeScript sends that JSX to the project's runtime instead of React's. The core
of the runtime is just this:

```ts
export const jsx = (
  type: ElementType,
  props: Html.Attributes | null,
  _key?: string | number
): Html.Html => {
  if (typeof type === "function") return type(props ?? {})
  return Html.element(type, props)
}
```

Function components are called directly; intrinsic elements go through the HTML
renderer and become a branded `Html` value ready for an Effect response.

## Full pages and htmx fragments

The same handlers choose a complete document or a focused fragment from the
`HX-Request` header:

```ts
const representation = (
  request: Parameters<typeof Htmx.isRequest>[0],
  todos: ReadonlyArray<Todo.Todo>
) => Htmx.isRequest(request) ? Html.app(todos) : Html.page(todos)

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
          yield* todos.add(payload.title)
          return representation(request, yield* todos.list)
        }))
  })
)
```

`Htmx.varyLayer` adds `Vary: HX-Request` to HTML responses, and helpers such as
`Htmx.retarget`, `Htmx.reswap`, `Htmx.redirect`, and `Htmx.trigger` set htmx
response headers.

## Checks

```sh
pnpm check  # Type-check source, examples, and compile-time test assertions
pnpm test   # Run renderer, form, and HTTP tests
```

## License

[MIT](LICENSE). Copyright (c) 2026 John Powers.
