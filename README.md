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
- Invalid submissions come back to the handler as `Submission.Invalid`, and
  `form.with(invalid)` renders the form again with the user's input and errors.
- `Deferred.derive` loads slow parts of a page from their own typed endpoints.
- `Csrf.layer` and `ErrorPage.layer` cover cross-site requests and HTML error
  pages as middleware.

The examples serve full pages to ordinary browser requests and HTML fragments
to htmx requests. The same forms work with or without JavaScript.

## Try it locally

Use Node.js 24+ and pnpm 11.15.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm example:todo
# open http://127.0.0.1:3000
```

| Example | Command | Open |
| --- | --- | --- |
| [Todo list](examples/todo-list/) | `pnpm example:todo` | <http://127.0.0.1:3000> |
| [Orders](examples/orders/) | `pnpm example:orders` | <http://127.0.0.1:3000> |
| [Sign-up](examples/signup/) | `pnpm example:signup` | <http://127.0.0.1:3000> |

Each command builds the source and starts its example on port 3000. Stop it with
Ctrl+C. Set `PORT` to use another port. The todo list is stored in
`todos.sqlite`; the orders and sign-up demos keep their state in memory, which
resets when the server restarts.

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

## Validation errors

A form endpoint's handler receives a `Submission`, which never fails to decode.
Yielding it gives the decoded payload, or fails with `Submission.Invalid`, which
keeps the submitted values, each field's messages, and messages for the form as
a whole. `NewTodo.reject(value, messages)` turns a domain error into the same
error, encoding the decoded value back into the form's values:

```ts
.handle("create", ({ payload, request }) =>
  Effect.gen(function* () {
    const { title } = yield* payload
    yield* todos.add(title).pipe(
      Effect.catchTags({
        DuplicateTodo: () =>
          Effect.fail(NewTodo.reject({ title }, {
            errors: { title: ["That is already on the list"] }
          })),
        TodoListFull: ({ limit }) =>
          Effect.fail(NewTodo.reject({ title }, {
            formErrors: [`The list is full at ${limit} todos. Finish one before adding more.`]
          }))
      })
    )
    return Htmx.isRequest(request) ? Html.app(yield* todos.list) : Html.seeOther("/")
  }).pipe(
    Effect.catchTag("FormInvalid", (invalid) =>
      Effect.map(todos.list, (items) =>
        Html.response(representation(request, items, invalid), { status: 422 })))
  ))
```

`NewTodo.with(invalid)` returns the same form components, filled in. Inputs,
textareas, checkboxes, and selects given `options` show the submitted values
(password inputs stay empty); controls with errors get `aria-invalid` and an
`aria-describedby` pointing at `<NewTodo.Error name="title" />`. Without a
`name`, `Error` shows the form's own messages, and `Root` points at it:

```tsx
const Form = NewTodo.with(invalid)

<Form.Root hx-boost="true" hx-push-url="false" hx-target="#todo-app" hx-swap="outerHTML">
  <Form.Error role="alert" class="error" />
  <Form.Label name="title">What needs doing?</Form.Label>
  <Form.Input name="title" required />
  <Form.Error name="title" class="error" />
  <button type="submit">Add todo</button>
</Form.Root>
```

htmx does not swap 4xx responses by default. Put `<Htmx.Config />` in the page
head to swap 422 responses as well.

A successful POST without htmx answers with `Html.seeOther`, a 303 redirect, so
that reloading the page does not submit the form again. `Htmx.seeOther(request,
location)` does the same for both: a 303 for the browser, or `HX-Location` for
htmx, which loads the page and pushes its URL.

### Writing messages

Messages come from the schema. Give each check a `message`, and give a field a
`messageMissingKey` for when it is left empty: forms submit an empty input as a
missing value, so optional fields can be left blank.

```ts
export const CreateTodo = Schema.Struct({
  title: Schema.Trim.check(
    Schema.isMinLength(1, { message: "Write what needs doing" }),
    Schema.isMaxLength(80, { message: "Keep it under 80 characters" })
  ).annotateKey({ messageMissingKey: "Write what needs doing" })
})
```

A field's `message` annotation also covers text that cannot be converted, such
as "twelve" for a number:

```ts
age: Schema.Int.check(Schema.isGreaterThanOrEqualTo(13))
  .annotate({ message: "Enter your age in years, 13 or over" })
```

### Rules across fields

Rules compare fields. Each lists the fields it reads and returns `true`, a
message for the form, or a message for one field:

```ts
const signUp = HttpFormEndpoint.make("signUp", "/sign-up", {
  payload: SignUp,
  rules: (rule) => [
    rule(["password", "confirmation"], (s) =>
      s.password === s.confirmation || { field: "confirmation", message: "The passwords do not match" }),
    rule(["age", "plan"], (s) =>
      s.plan !== "team" || s.age >= 16 || "Team plans are for people aged 16 and over")
  ]
})
```

A rule receives only the fields it lists, decoded, and runs as soon as they are
valid, so its message appears alongside the other fields' messages instead of
after they are fixed. While any of them is invalid, the rule is skipped: there
is no "The passwords do not match" next to "Use at least 12 characters".
`Form.make` and `Submission.schema` take `rules` too.

Checks on the whole Struct, with `.check`, still work and become form errors,
but Effect runs them only once every field is valid. Keep them for rules the
schema must enforce everywhere, such as when it also decodes JSON.

An unchecked checkbox is not submitted, so a missing `Schema.Boolean` field is
`false`. Use `Schema.Literal(true)` for a box that must be checked, such as
accepting terms.

Fields without messages fall back to Effect's defaults, such as "Expected a
value with a length of at least 1", and "Required" for empty fields.

### Placing messages

`Error` and `Summary` cover the common layouts, and the form's messages are
available for anything else:

```tsx
// Style the whole field, not just its message
<div class={Form.hasErrors("title") ? "field field--invalid" : "field"}>
  <Form.Label name="title">What needs doing?</Form.Label>
  <Form.Input name="title" />
  {/* Choose the markup; the element keeps the id that aria-describedby uses */}
  <Form.Error name="title" as="ul" class="errors">
    {(messages) => messages.map((message) => <li>{message}</li>)}
  </Form.Error>
</div>
```

`Form.messages(name)` returns a field's messages, and without a name, the
form's own. `Form.invalid` tells whether there are any messages at all.

`<Form.Summary />` lists every message at the top of the form: the form's own,
then each field's in schema order, linking to its control. Long forms benefit
most. It has `role="alert"` and `autofocus`, so the browser moves focus to it
after a full page load and htmx after a swap, without extra JavaScript. It
includes the form's own messages, so use it instead of a nameless `Error`. The
[sign-up example](examples/signup/App.tsx) puts it at the top of a long form.

### Forms without an HttpFormEndpoint

`HttpFormEndpoint.make` is a shortcut. A form built with `Form.make` has the
same `Submission` payload schema, so any endpoint can receive it, including one
with path parameters:

```ts
const Rename = Form.make({
  id: "rename",
  action: "/todos/1/rename",
  payload: Schema.Struct({ title: Todo.Title })
})

const rename = HttpViewEndpoint.post("rename", "/todos/:id/rename", {
  params: { id: Schema.Int },
  payload: Rename.payload
})
```

`Submission.schema(struct)` makes the same payload without a form, and
`Submission.decode(struct, values)` decodes values directly.

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
  })
)
```

`Htmx.varyLayer` adds `Vary: HX-Request` to HTML responses, and helpers such as
`Htmx.retarget`, `Htmx.reswap`, `Htmx.redirect`, and `Htmx.trigger` set htmx
response headers.

## Error pages

Handle expected errors where they happen, and choose their status with
`Html.response`:

```tsx
orders.get(params.orderId).pipe(
  Effect.map((order) => representation(request, <OrderView order={order} />)),
  Effect.catchTag("OrderNotFound", (error) =>
    Effect.succeed(Html.response(<NotFound orderId={error.orderId} />, { status: 404 })))
)
```

`ErrorPage.layer` renders everything else: unknown routes, invalid params,
unexpected failures, and other middleware's non-HTML error responses, such as
the CSRF 403. It keeps the status, logs failures that would have been a 500, and
leaves requests that do not accept HTML, such as JSON API calls, alone:

```tsx
const errorPages = ErrorPage.layer(({ htmx, status }) =>
  htmx ? <p>Something went wrong ({status})</p> : <Page><h1>Error {status}</h1></Page>
)
```

htmx does not swap error responses by default. `<Htmx.Config errorTarget="#errors" />`
swaps them into an element of the page instead of its usual target.

## Cross-site request forgery

`Csrf.layer()` rejects cross-origin POST, PUT, PATCH, and DELETE requests with a
403. It needs no tokens or session state: browsers send `Sec-Fetch-Site` with
every request, and the middleware falls back to comparing `Origin` with `Host`.
Requests with neither header, such as those from curl, are allowed, since no
browser can be tricked into sending them.

```ts
const app = Layer.mergeAll(routes, Htmx.varyLayer, Csrf.layer())
```

Pass `trustedOrigins` for other sites that may submit forms to the application,
and `reject` to customize the response. Behind a proxy that rewrites `Host`,
browsers without Fetch Metadata need the public origin in `trustedOrigins`. Set
session cookies with `SameSite=Lax` as well.

## Async views

Components stay synchronous. TypeScript gives every JSX expression the same
type, so a component's services and errors would disappear inside a tree.
Load data in Effect instead, and render once it has arrived:

```tsx
const ActivityPanel = Effect.gen(function* () {
  const orders = yield* Orders
  const events = yield* orders.activity
  return <section><ol>{events.map((event) => <li>{event}</li>)}</ol></section>
})
// Effect<Html, never, Orders>
```

Compose these with `Effect.all` (optionally concurrent), recover with
`Effect.catchTag`, and the requirements and errors stay in the types.

When part of a page is slow, `Deferred.derive` puts it behind its own GET view
endpoint and renders a placeholder that htmx replaces once the page has loaded:

```tsx
const orderActivity = HttpViewEndpoint.get("activity", "/orders/:orderId/activity", {
  params: { orderId: Schema.Int }
})

const Activity = Deferred.derive({ endpoint: orderActivity })

<Activity.Root params={{ orderId: order.id }}>
  <p>Loading activity…</p>
</Activity.Root>
// <div hx-get="/orders/42/activity" hx-trigger="load" hx-swap="outerHTML">…</div>
```

Params and query are typed by the endpoint and encoded with its schemas.
`trigger` accepts any htmx trigger, such as `"revealed"` or `"every 30s"`, and
`Activity.url(...)` builds the same URL for links. Deferred content needs
JavaScript, so keep essential content in the page or link to the fragment's
endpoint from a `<noscript>`.

## Checks

```sh
pnpm check  # Type-check source, examples, and compile-time test assertions
pnpm test   # Run renderer, form, and HTTP tests
```

## License

[MIT](LICENSE). Copyright (c) 2026 John Powers.
