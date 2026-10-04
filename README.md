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
- `View.derive` turns a GET view endpoint into typed links, and placeholders that
  load slow parts of a page later.
- `Csrf.layer` and `ErrorPage.layer` cover cross-site requests and HTML error
  pages as middleware.
- `Component.make` keeps a component's markup and scoped CSS in one `.tsx`
  file. Live components add actions that run on the server as HttpApi
  endpoints, with typed state and payloads, and no JavaScript of your own in
  the browser. `Assets.layer` serves the styles and htmx without a build step.

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
  <NewTodo.Root hx-post={NewTodo.action} hx-target="#todo-app" hx-swap="outerHTML">
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

With htmx, `hx-post` submits the form and swaps the response into
`#todo-app`; without JavaScript, the browser submits it as usual.

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
    return Htmx.wantsFragment(request) ? Html.app(yield* todos.list) : Html.seeOther("/")
  }).pipe(
    Effect.catchTag("FormInvalid", (invalid) =>
      Effect.map(todos.list, (items) =>
        page(request, Html.app(items, invalid), { status: 422 })))
  ))
```

`NewTodo.with(invalid)` returns the same form components, filled in. Inputs,
textareas, checkboxes, and selects given `options` show the submitted values
(password inputs stay empty); controls with errors get `aria-invalid` and an
`aria-describedby` pointing at `<NewTodo.Error name="title" />`. Without a
`name`, `Error` shows the form's own messages, and `Root` points at it:

```tsx
const Form = NewTodo.with(invalid)

<Form.Root hx-post={Form.action} hx-target="#todo-app" hx-swap="outerHTML">
  <Form.Error role="alert" class="error" />
  <Form.Label name="title">What needs doing?</Form.Label>
  <Form.Input name="title" required />
  <Form.Error name="title" class="error" />
  <button type="submit">Add todo</button>
</Form.Root>
```

htmx does not swap 4xx responses by default. Put `<Htmx.Config />` in the page
head to swap 422 responses as well.

A successful POST that expects a page answers with `Html.seeOther`, a 303
redirect, so that reloading the page does not submit the form again.
`Htmx.seeOther(request, location)` covers htmx too: a 303 for ordinary and
boosted requests, which htmx follows, and `HX-Redirect` for other htmx
requests, so the browser loads the whole page.

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

Short forms often need no summary. `NewTodo.with(invalid, { autofocusError: true })`
gives the first invalid control `autofocus`, so the browser focuses it after a
full page load and htmx after a swap, and a screen reader reads its label and
error.

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
    <NewTodo.Root hx-post={NewTodo.action} hx-target="#todo-app" hx-swap="outerHTML">
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

The same handlers serve a complete page to the browser and just the view to
htmx. `Htmx.layout` takes the page component once:

```tsx
const page = Htmx.layout(Page)
```

```tsx
.handle("show", ({ params, request }) =>
  Effect.gen(function* () {
    const order = yield* orders.get(params.orderId)
    return page(request, <OrderView order={order} />)
  })
)
```

`page(request, view)` returns the view on its own for htmx requests, and inside
`Page` for ordinary requests and for boosted links and forms, which swap the
whole body. `Htmx.wantsFragment(request)` makes the same decision for your own
code. `page(request, view, { status: 404 })` does the same with a status.
Use `hx-post` or `hx-get`, not `hx-boost`, for elements that swap a fragment.

`Htmx.varyLayer` adds `Vary: HX-Request, HX-Boosted` to HTML responses, and
helpers such as `Htmx.retarget`, `Htmx.reswap`, `Htmx.redirect`, and
`Htmx.trigger` set htmx response headers.

## Error pages

Handle expected errors where they happen, and choose their status:

```tsx
.handle("show", ({ params, request }) =>
  orders.get(params.orderId).pipe(
    Effect.map((order) => page(request, <OrderView order={order} />)),
    Effect.catchTag("OrderNotFound", () =>
      Effect.succeed(page(request, <NotFound />, { status: 404 }))
    )
  )
)
```

`ErrorPage.layer` renders everything else: unknown routes, invalid params,
unexpected failures, and other middleware's non-HTML error responses, such as
the CSRF 403. It keeps the status, logs failures that would have been a 500, and
leaves requests that do not accept HTML, such as JSON API calls, alone:

```tsx
const errorPages = ErrorPage.layer(({ fragment, status }) =>
  fragment ? <p>Something went wrong ({status})</p> : <Page><h1>Error {status}</h1></Page>
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

When part of a page is slow, put it behind its own GET view endpoint and load it
after the page, with a `View`.

## Links and lazy views

`View.derive` does for a GET view endpoint what `Form.derive` does for a form:
it returns typed components, with params and query checked against the
endpoint's schemas and encoded as the server decodes them.

```tsx
const orderActivity = HttpViewEndpoint.get("activity", "/orders/:orderId/activity", {
  params: { orderId: Schema.Int }
})

const Activity = View.derive({ endpoint: orderActivity })

<Activity.Link params={{ orderId: 42 }}>View activity</Activity.Link>
// <a href="/orders/42/activity">View activity</a>

<Activity.Lazy params={{ orderId: 42 }}>
  <p>Loading activity…</p>
</Activity.Lazy>
// <div hx-get="/orders/42/activity" hx-trigger="load" hx-swap="outerHTML">…</div>

Activity.url({ params: { orderId: 42 } }) // "/orders/42/activity"
```

`Lazy` renders a placeholder that htmx replaces with the view. `trigger` accepts
any htmx trigger, such as `"revealed"` or `"every 30s"`, and `as` chooses the
element. It needs JavaScript, so keep essential content in the page, or put an
`Activity.Link` in a `<noscript>`.

## Components

`Component.make` defines markup rendered inside a custom element, with styles
scoped to it:

```tsx
import * as Component from "effect-views/Component"
import { css } from "effect-views/Component"

const Card = Component.make("app-card", {
  style: css`
    :scope { display: block; padding: 1rem; border: 1px solid #ddd; }
    h2 { margin-top: 0; }
  `,
  render: ({ title, children }: { title: string; children: Html.Child }) => (
    <>
      <h2>{title}</h2>
      {children}
    </>
  )
})

<Card title="Details">…</Card>
// <app-card data-component><h2>Details</h2>…</app-card>
```

Styles are wrapped in `@scope`, so they apply inside the element, with `:scope`
for the element itself, and stop at nested components. Editors highlight CSS in
templates tagged `css`.

## Live components

A live component is rendered on the server, and its actions run on the server:
htmx posts the component's state to an action, and swaps in the component
rendered with the state the action returns. No JavaScript of your own runs in
the browser, so handlers can use services, the database, and anything else on
the server.

Like an HttpApi endpoint, a live component is declared in one place and
implemented in another. The contract holds the state and the actions:

```ts
import * as LiveAction from "effect-views/LiveAction"
import * as LiveComponent from "effect-views/LiveComponent"

export class SearchState extends Schema.Class<SearchState>("SearchState")({
  query: Schema.String,
  matches: Schema.Array(Todo)
}) {}

export const search = LiveAction.make("search", {
  payload: { query: Schema.optionalKey(Schema.String) }
})

export const Search = LiveComponent.make("todo-search", { state: SearchState }).add(search)
```

The view needs only the contract, so it renders without the handlers or their
services. Each action becomes ordinary htmx attributes: `hx-post`,
`hx-include`, `hx-target`, and `hx-swap`. Add others, such as `hx-trigger`,
beside them:

```tsx
export const SearchView = LiveComponent.view(Search, {
  style: css`:scope { display: block; }`,
  render: (state, actions) => (
    <>
      <input id="search" type="search" name="query" value={state.query}
        {...actions.search()} hx-trigger="input changed delay:200ms" />
      <ul>{state.matches.map((todo) => <li>{todo.title}</li>)}</ul>
    </>
  )
})

<SearchView state={new SearchState({ query: "", matches: [] })} />
```

The handlers are a layer, with the services they use provided to it. They
return the next state, and TypeScript requires one for every action:

```ts
export const SearchHandlers = LiveComponent.handlers(SearchView, {
  search: (_state, { query = "" }) =>
    Effect.gen(function* () {
      const todos = yield* Todos
      return new SearchState({ query, matches: yield* todos.search(query) })
    })
}).pipe(Layer.provide(Todos.layer))
```

Actions are HttpApi endpoints. Add them to the group of the views the
component appears in, so that the group's HttpApi middleware, such as
authentication, applies to them, and the OpenAPI document lists them with
those views. Then handle them in that group's handlers; TypeScript requires
both, and the group's layer requires the component's handlers:

```ts
export const group = HttpApiGroup.make("todosViews")
  .add(list, create)
  .add(...LiveComponent.endpoints(Search))

export const TodosViewsLayer = HttpApiBuilder.group(Api, "todosViews", (handlers) =>
  handlers
    .handle("list", …)
    .handle("create", …)
    .pipe(LiveComponent.handle(Search))
).pipe(Layer.provide([Todos.layer, SearchHandlers]))
```

Give an action a `description` to summarize it in the OpenAPI document.

- **State** is encoded with its schema and signed, in a hidden input, so the
  server keeps nothing between requests and the browser cannot change it. A
  problem to show the user, such as a failed search, belongs in the state.
- **Payloads** are decoded like forms, from the inputs in the component and
  any values given where the action is used, such as `actions.add({ by: 5 })`.
- htmx keeps focus in an input with the same `id` after the swap, so give
  inputs that trigger actions an `id`.
- Actions are served at `/live/<tag>/<action>`; do not prefix their group or
  its API. An action answers 400 when its state or payload cannot be decoded.
- State is signed with a key chosen at startup, so nothing needs to be
  provided. Pages rendered before a restart, or by another server, stop
  accepting actions; to share a key, provide
  `LiveComponent.secret(Redacted.make(...))` to `HttpRouter.serve`.

### Assets

`Assets.layer` builds the files when the server starts: htmx from the installed
`htmx.org`, and one stylesheet for every component. `Assets.routes` serves them
with names that change with their contents, cached for a year. Put
`<Assets.Head />` in the page head, and provide `Assets.layer` to
`HttpRouter.serve`, rather than adding it to the routes, so that error pages
rendered by middleware can render the head too.

Pass `htmx: { url }` to load htmx from elsewhere, `htmx: false` to leave it
out, `extensions: ["sse"]` to serve htmx extensions from their `htmx-ext-<name>`
packages, or `prefix` to serve the files from somewhere other than `/assets`.
Components must be defined before the layer is built; rendering one defined
later is an error.

## Streaming views

`HttpViewEndpoint.events` declares a GET endpoint that streams HTML fragments
as server-sent events. Its handler returns a `Stream` of `HtmlEvent`, each an
event name and its HTML, and `View.derive` gives it a `Subscribe` element whose
contents htmx replaces with each event of that name:

```tsx
export const changes = HttpViewEndpoint.events("changes", "/todos/changes")

const Changes = View.derive({ endpoint: changes })

<Changes.Subscribe event="todos">
  <TodoList todos={todos} />
</Changes.Subscribe>
// <div hx-ext="sse" sse-connect="/todos/changes" sse-swap="todos">…</div>
```

```ts
.handle("changes", () =>
  Effect.succeed(todos.changes.pipe(
    Stream.map((items) => ({ event: "todos", data: <TodoList todos={items} /> }))
  )))
```

The endpoint is an ordinary HttpApi endpoint, with the API's middleware, and
the OpenAPI document describes it as `text/event-stream`. The stream ends when
the browser closes the connection, such as when htmx swaps the element out.
`Subscribe` needs htmx's sse extension: install `htmx-ext-sse` and pass
`extensions: ["sse"]` to `Assets.layer`.

A stream that starts with the current state, such as `SubscriptionRef.changes`,
keeps pages in step when the browser reconnects after losing the connection.

## Checks

```sh
pnpm check  # Type-check source, examples, and compile-time test assertions
pnpm test   # Run renderer, form, and HTTP tests
```

## License

[MIT](LICENSE). Copyright (c) 2026 John Powers.
