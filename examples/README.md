# Runnable examples

Three local examples of [effect-views](../README.md). Use Node.js 24+ and
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

Open <http://127.0.0.1:3000> and add a todo. With htmx, served by
`Assets.layer`, the form updates the todo section without navigating. Disable JavaScript and reload
to try the same form: it redirects back to the list, so reloading does not add
the todo twice.

Submit an empty or overlong title, or one already on the list, to see the form
returned with the title you typed and a message written in
[`Domain/Todo.ts`](todo-list/Domain/Todo.ts). The list holds ten todos; past
that, the form shows an error of its own. Todos are stored with SQLite in `todos.sqlite` (set
`TODOS_DB` to use another file) and survive restarts; delete the file to start
over.

`Form.derive` uses the endpoint's path as the form action and its payload schema
to constrain control names. Labels and layout are written by hand.

Type in "Find a todo" to search the list. It is a live component: each search
runs on the server, with the same Todos service as the handlers, and htmx swaps
in the results. Its contract is in [`Todos/Views.ts`](todo-list/Todos/Views.ts),
its markup in [`Todos/Search.tsx`](todo-list/Todos/Search.tsx), and its handler
in [`Todos/Http.ts`](todo-list/Todos/Http.ts); its action is an endpoint
in the same group as the todo pages.

### Use the JSON API from the terminal

The same todos are available as JSON at `/api/todos`, and the example comes
with a command-line client for them. With the server running, open a second
terminal:

```sh
pnpm -s example:todo:cli list
pnpm -s example:todo:cli add "Water the plants"
```

The page in your browser shows the new todo as soon as it is added, without
reloading. The list subscribes to a [stream of server-sent
events](todo-list/Todos/Views.ts): the server sends the list when the page
connects, and again each time any client adds a todo, and htmx swaps it in.
Open the page in two windows and add a todo in one to see it arrive in the
other.

The [CLI](todo-list/cli.ts) uses a client that `HttpApiClient` derives from the
API's contract, so its requests and responses are typed with the schemas the
server uses. Adding a title that is already on the list fails with the same
`DuplicateTodo` error that the form shows as a message, and an empty title is
rejected, with the schema's message, before anything is sent. Set `PORT` or
`TODOS_URL` to reach a server elsewhere.

The API's OpenAPI document is at <http://127.0.0.1:3000/openapi.json>, with a
reference page at <http://127.0.0.1:3000/docs> that lists the pages, fragments,
and live components under "Views", and the JSON under "API".

### Read the code

1. [`todo-list/Domain/Todo.ts`](todo-list/Domain/Todo.ts) defines the data schemas.
2. [`todo-list/Todos/Views.ts`](todo-list/Todos/Views.ts) declares the HTML endpoints.
3. [`todo-list/Todos/Html.tsx`](todo-list/Todos/Html.tsx) derives the form, defines
   the search, and renders either the app fragment or a document
   containing it.
4. [`todo-list/Todos/Http.ts`](todo-list/Todos/Http.ts) implements HTML and JSON
   handlers using the same [domain service](todo-list/Todos.ts), which stores
   todos with Effect SQL.
5. [`todo-list/RootApi.ts`](todo-list/RootApi.ts) combines the HTML and JSON
   contracts; [`todo-list/Http.ts`](todo-list/Http.ts) assembles the server.
6. [`todo-list/cli.ts`](todo-list/cli.ts) uses the JSON API from the terminal.

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

## Sign-up: a long form with an error summary

```sh
pnpm example:signup
```

Open <http://127.0.0.1:3000> and press **Create account** without filling
anything in. A summary at the top lists every problem, linking to each field,
and takes focus. Then try:

- "thirty" for the age, or a short password: the messages come from the
  [schema](signup/App.tsx), next to the rules they explain.
- Different passwords: a rule across two fields, shown on the second.
- A Team plan at age 14: a rule about the whole form, shown first in the summary.
- The email address ada@example.com, which is taken: the form comes back with
  everything you entered except the passwords.

A valid submission creates the account and goes to its page, with htmx or
without JavaScript. Accounts are kept in memory until the server restarts.

## Orders: pages and fragments

```sh
pnpm example:orders
```

Open <http://127.0.0.1:3000>, choose order 42, and click **Cancel order**. With
htmx, only the order article changes; without JavaScript, the browser loads a
new page. The activity panel loads separately, about 400 ms after the page,
through `View.derive`; without JavaScript it becomes a link. Return to the
index to see the updated status. Restart the server to reset the order.

Order #7 does not exist: its handler answers with a 404 page. Unknown paths,
such as <http://127.0.0.1:3000/nope>, and invalid ones, such as
<http://127.0.0.1:3000/orders/abc>, get error pages from `ErrorPage.layer`.

Read [`orders/App.tsx`](orders/App.tsx) for the contract, in-memory service,
views, and handlers. [`orders/main.tsx`](orders/main.tsx) starts the server.

`pnpm example` also starts the orders demo. `pnpm dev` watches its example
files. After editing `src/`, restart the command to rebuild the library. See the
[root check commands](../README.md#checks) for type checking and tests.
