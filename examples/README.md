# Runnable examples

Two local examples of [effect-views](../README.md). Use Node.js 22+ and
pnpm 11.15.0, and run commands from the repository root.

```sh
pnpm install --frozen-lockfile
```

Each run command builds the source and starts a server on `127.0.0.1`. Stop it
with Ctrl+C. State is shared across browser sessions and resets on restart.

## Todo list: schema-bound forms

```sh
pnpm example:todo
```

Open <http://127.0.0.1:3001> and add a todo. With htmx loaded, the form updates
the todo section without navigating. Disable JavaScript and reload to try the
same form with a full-page response.

`Form.derive` uses the endpoint's path as the form action and its payload schema
to constrain control names. Labels and layout are written by hand.

### Read the code

1. [`todo-list/Domain/Todo.ts`](todo-list/Domain/Todo.ts) defines the data schemas.
2. [`todo-list/Todos/Views.ts`](todo-list/Todos/Views.ts) declares the HTML endpoints.
3. [`todo-list/Todos/Html.tsx`](todo-list/Todos/Html.tsx) derives the form and renders
   either the app fragment or a document containing it.
4. [`todo-list/Todos/Http.ts`](todo-list/Todos/Http.ts) implements HTML and JSON
   handlers using the same [domain service](todo-list/Todos.ts).
5. [`todo-list/RootApi.ts`](todo-list/RootApi.ts) combines the HTML and JSON
   contracts; [`todo-list/Http.ts`](todo-list/Http.ts) assembles the server.

### Make requests with curl

With the server running, open a second terminal:

```sh
# Full HTML document
curl -i http://127.0.0.1:3001/

# The same route, returning only the app fragment
curl -i -H 'HX-Request: true' http://127.0.0.1:3001/

# Submit the URL-encoded form and receive an updated fragment
curl -i -H 'HX-Request: true' \
  --data-urlencode 'title=Explore typed forms' \
  http://127.0.0.1:3001/todos

# Read the same state through the JSON API
curl -i http://127.0.0.1:3001/api/todos
```

Successful HTML responses include `Vary: HX-Request` so caches can distinguish
pages from fragments.

## Orders: pages and fragments

```sh
pnpm example:orders
```

Open <http://127.0.0.1:3000/orders/42> and click **Cancel order**. With htmx,
only the order article changes; without JavaScript, the browser loads a new
page. Restart the server to reset the order.

Read [`orders/App.tsx`](orders/App.tsx) for the contract, in-memory service,
views, and handlers. [`orders/main.tsx`](orders/main.tsx) starts the server.
There is only one hard-coded order; the handlers ignore the ID in the URL.

`pnpm example` also starts the orders demo. `pnpm dev` watches its example
files. After editing `src/`, restart the command to rebuild the library.

## Limitations

- No persistence, authentication, or application-level CSRF protection. Do not
  expose these servers publicly.
- htmx loads from a CDN and needs network access. Forms still submit if it
  cannot load.
- Invalid submissions return HTTP 400 without displaying validation errors.
- Native POST submissions return HTML directly rather than redirecting, so
  refreshing afterward can resubmit the form.

See [the root README](../README.md#known-gaps) for renderer and form limitations,
and [check commands](../README.md#checks) for type checking and tests.
