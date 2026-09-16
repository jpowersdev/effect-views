# effect-views

An experiment in server-rendered HTML and schema-bound forms with Effect and htmx.

**Status: unfinished proof of concept, not intended for production use.**

## The idea

An endpoint already describes the data a form submits. This experiment reuses
that contract to constrain field names and control types, while leaving markup
and layout to the application.

It pairs Effect's `HttpApiEndpoint` with server-side JSX and an HTML response
schema. The examples return full pages for ordinary browser requests and HTML
fragments for htmx requests. Forms work with or without JavaScript.

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

Both commands build the source and start a server. Stop it with Ctrl+C. These
are local demos with shared, in-memory state and no authentication or
application-level CSRF protection.

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

`Root` emits `method="post"` and `action="/todos"`. The schema constrains the
input's `name`, but labels, layout, and validation attributes such as `required`
are written by hand. Form derivation does not generate the page or its error
messages. `hx-push-url="false"` keeps htmx from putting the POST-only action URL
into browser history, so refreshing still requests the page's GET route.

The `effect-views` imports resolve to this repository's code after building.

## Where to read next

- [`src/Html.ts`](src/Html.ts): HTML representation, text/attribute escaping, and
  the `text/html` response schema.
- [`src/jsx-runtime.ts`](src/jsx-runtime.ts): synchronous JSX composition.
- [`src/HttpViewEndpoint.ts`](src/HttpViewEndpoint.ts): endpoint constructors with
  an HTML success schema.
- [`src/HttpFormEndpoint.ts`](src/HttpFormEndpoint.ts): POST endpoints with
  URL-encoded struct payloads.
- [`src/Form.ts`](src/Form.ts): explicit (`make`) or endpoint-derived (`derive`)
  controls, including inputs, textareas, checkboxes, selects, and labels.
- [`src/Htmx.ts`](src/Htmx.ts): request-header checks, response-header helpers, and
  `Vary: HX-Request` middleware.

## Known gaps

This code was built against Effect `4.0.0-beta.106` and its unstable HTTP APIs.
Other Effect versions have not been tested.

- Forms support flat structs, not nested fields. Select option values are not
  checked against the schema at compile time.
- `Form.derive` copies the endpoint path literally, without substituting path
  parameters. Transformations such as `.prefix()` discard the metadata it needs.
- An unchecked checkbox submits no value. Required boolean fields fail decoding
  unless the application handles that absence.
- Boolean ARIA/htmx attributes are not serialized correctly; use string values
  such as `aria-expanded="false"` rather than boolean JSX values.
- JSX attribute types are permissive: they do not check HTML structure or
  accessibility.
- The examples do not preserve invalid form values, render validation errors, or
  redirect after successful POST requests.

## Escaping and trust

String children and attribute values are HTML-escaped; existing `Html` values
are inserted as markup. The renderer rejects native `on*` event attributes,
`srcdoc`, and `dangerouslySetInnerHTML`. It also blocks `javascript:`,
`vbscript:`, and `data:` schemes in the URL attributes it recognizes. These
checks do not make it a sanitizer.

HTML escaping does not protect JavaScript or CSS contexts. The renderer also
allows htmx expressions such as `hx-on:*`. Keep templates under application
control, and do not interpolate untrusted values into executable contexts.

The `Html` brand does not certify its contents. Both `Html.unsafe` and decoding
a string through `Html.schema` accept raw markup without sanitization.

## Checks

```sh
pnpm check  # Type-check source, examples, and compile-time test assertions
pnpm test   # Run renderer, form, and HTTP tests
```

The tests cover selected rendering and HTTP behavior. They do not exercise
browser interactions or constitute a security audit.

## License

[MIT](LICENSE). Copyright (c) 2026 John Powers.
