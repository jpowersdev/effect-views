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
# open http://127.0.0.1:3001
```

| Example | Command | Open |
| --- | --- | --- |
| [Todo list](examples/todo-list/) | `pnpm example:todo` | <http://127.0.0.1:3001> |
| [Orders](examples/orders/) | `pnpm example:orders` | <http://127.0.0.1:3000/orders/42> |

Both commands build the source and start a server. Stop it with Ctrl+C. Demo
state is held in memory and resets when the server restarts.

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

`hx-push-url="false"` keeps the POST-only action out of browser history. The
`effect-views` imports resolve to this repository's code after building.

## Where to read next

- [`src/Html.ts`](src/Html.ts): HTML representation, text/attribute escaping, and
  the `text/html` response schema.
- [`src/jsx-runtime.ts`](src/jsx-runtime.ts): the small, synchronous JSX runtime
  that takes React's place.
- [`src/HttpViewEndpoint.ts`](src/HttpViewEndpoint.ts): endpoint constructors with
  an HTML success schema.
- [`src/HttpFormEndpoint.ts`](src/HttpFormEndpoint.ts): POST endpoints with
  URL-encoded struct payloads.
- [`src/Form.ts`](src/Form.ts): explicit (`make`) or endpoint-derived (`derive`)
  controls, including inputs, textareas, checkboxes, selects, and labels.
- [`src/Htmx.ts`](src/Htmx.ts): request-header checks, response-header helpers, and
  `Vary: HX-Request` middleware.

## Checks

```sh
pnpm check  # Type-check source, examples, and compile-time test assertions
pnpm test   # Run renderer, form, and HTTP tests
```

## License

[MIT](LICENSE). Copyright (c) 2026 John Powers.
