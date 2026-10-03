# Runnable examples

Two local examples of [effect-views](../README.md). Use Node.js 22.13+ and
pnpm 11.15.0, and run commands from the repository root.

```sh
pnpm install --frozen-lockfile
```

Each run command builds the source and starts its example at
`http://127.0.0.1:3000`. Stop it with Ctrl+C. Set `PORT` to use another port.
State is shared across browser sessions.

## Todo list: schema-bound forms

```sh
pnpm example:todo
```

Open <http://127.0.0.1:3000> and add a todo. With htmx loaded from the CDN, the
form updates the todo section without navigating. Disable JavaScript and reload
to try the same form: it redirects back to the list, so reloading does not add
the todo twice.

Add a todo that is already on the list to see the form returned with an error
and the title you typed. Todos are stored with SQLite in `todos.sqlite` (set
`TODOS_DB` to use another file) and survive restarts; delete the file to start
over.

`Form.derive` uses the endpoint's path as the form action and its payload schema
to constrain control names. Labels and layout are written by hand.

### Read the code

1. [`todo-list/Domain/Todo.ts`](todo-list/Domain/Todo.ts) defines the data schemas.
2. [`todo-list/Todos/Views.ts`](todo-list/Todos/Views.ts) declares the HTML endpoints.
3. [`todo-list/Todos/Html.tsx`](todo-list/Todos/Html.tsx) derives the form and renders
   either the app fragment or a document containing it.
4. [`todo-list/Todos/Http.ts`](todo-list/Todos/Http.ts) implements HTML and JSON
   handlers using the same [domain service](todo-list/Todos.ts), which stores
   todos with Effect SQL.
5. [`todo-list/RootApi.ts`](todo-list/RootApi.ts) combines the HTML and JSON
   contracts; [`todo-list/Http.ts`](todo-list/Http.ts) assembles the server.

### Make requests with curl

With the server running, open a second terminal:

```sh
# Full HTML document
curl -i http://127.0.0.1:3000/

# The same route, returning only the app fragment
curl -i -H 'HX-Request: true' http://127.0.0.1:3000/

# Submit the URL-encoded form and receive an updated fragment
curl -i -H 'HX-Request: true' \
  --data-urlencode 'title=Explore typed forms' \
  http://127.0.0.1:3000/todos

# A duplicate title: 422 with the form and its error
curl -i -H 'HX-Request: true' \
  --data-urlencode 'title=Explore typed forms' \
  http://127.0.0.1:3000/todos

# Read the same state through the JSON API
curl -i http://127.0.0.1:3000/api/todos
```

Successful HTML responses include `Vary: HX-Request` so caches can distinguish
pages from fragments.

## Orders: pages and fragments

```sh
pnpm example:orders
```

Open <http://127.0.0.1:3000>, choose order 42, and click **Cancel order**. With
htmx, only the order article changes; without JavaScript, the browser loads a
new page. The activity panel loads separately, about 400 ms after the page,
through `Deferred.derive`; without JavaScript it becomes a link. Return to the
index to see the updated status. Restart the server to reset the order.

Order #7 does not exist: its handler answers with a 404 page. Unknown paths,
such as <http://127.0.0.1:3000/nope>, and invalid ones, such as
<http://127.0.0.1:3000/orders/abc>, get error pages from `ErrorPage.layer`.

Read [`orders/App.tsx`](orders/App.tsx) for the contract, in-memory service,
views, and handlers. [`orders/main.tsx`](orders/main.tsx) starts the server.

`pnpm example` also starts the orders demo. `pnpm dev` watches its example
files. After editing `src/`, restart the command to rebuild the library. See the
[root check commands](../README.md#checks) for type checking and tests.
