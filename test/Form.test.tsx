/** @jsxImportSource effect-views */

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as Vitest from "vitest"

import * as Form from "../src/Form.js"
import * as Html from "../src/Html.js"
import * as HttpFormEndpoint from "../src/HttpFormEndpoint.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"
import * as Submission from "../src/Submission.js"

const TodoForm = Form.make({
  id: "new-todo",
  action: "/todos",
  payload: Schema.Struct({
    title: Schema.NonEmptyString,
    notes: Schema.String,
    priority: Schema.Literals(["low", "normal", "high"]),
    notify: Schema.Boolean,
    count: Schema.Int
  })
})

Vitest.describe("Form", () => {
  Vitest.it("renders controls with schema-bound names and label associations", () => {
    const view = (
      <TodoForm.Root hx-boost="true">
        <TodoForm.Label name="title">What needs doing?</TodoForm.Label>
        <TodoForm.Input name="title" autocomplete="off" required />
        <TodoForm.Label name="notes">Notes</TodoForm.Label>
        <TodoForm.Textarea name="notes" rows={4} />
        <TodoForm.Label name="priority">Priority</TodoForm.Label>
        <TodoForm.Select name="priority">
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </TodoForm.Select>
        <TodoForm.Checkbox name="notify" />
        <TodoForm.Input name="count" type="number" min={0} />
        <button type="submit">Add todo</button>
      </TodoForm.Root>
    )

    Vitest.expect(Html.render(view)).toBe(
      `<form hx-boost="true" id="new-todo" method="post" action="/todos">` +
        `<label for="new-todo-title">What needs doing?</label>` +
        `<input autocomplete="off" required id="new-todo-title" name="title" type="text">` +
        `<label for="new-todo-notes">Notes</label>` +
        `<textarea rows="4" id="new-todo-notes" name="notes"></textarea>` +
        `<label for="new-todo-priority">Priority</label>` +
        `<select id="new-todo-priority" name="priority">` +
          `<option value="low">Low</option>` +
          `<option value="normal">Normal</option>` +
          `<option value="high">High</option>` +
        `</select>` +
        `<input id="new-todo-notify" name="notify" type="checkbox" value="true">` +
        `<input min="0" id="new-todo-count" name="count" type="number">` +
        `<button type="submit">Add todo</button>` +
      `</form>`
    )
  })

  Vitest.it("exposes the configured action and URL-encoded payload schema", () => {
    Vitest.expect(TodoForm.action).toBe("/todos")
    Vitest.expect(TodoForm.payload).toBeDefined()
    Vitest.expect(TodoForm.idFor("title")).toBe("new-todo-title")
  })

  Vitest.it("derives its action and fields from an HttpFormEndpoint", () => {
    const endpoint = HttpFormEndpoint.make("create", "/contacts", {
      payload: Schema.Struct({ email: Schema.String })
    })
    const ContactForm = Form.derive({ id: "new-contact", endpoint })

    const view = (
      <ContactForm.Root>
        <ContactForm.Label name="email">Email</ContactForm.Label>
        <ContactForm.Input name="email" type="email" />
      </ContactForm.Root>
    )

    Vitest.expect(ContactForm.endpoint).toBe(endpoint)
    Vitest.expect(ContactForm.action).toBe("/contacts")
    Vitest.expect(Html.render(view)).toBe(
      `<form id="new-contact" method="post" action="/contacts">` +
        `<label for="new-contact-email">Email</label>` +
        `<input id="new-contact-email" name="email" type="email">` +
      `</form>`
    )
  })

  Vitest.it("fills controls with an invalid submission's values and errors", () => {
    const invalid = new Submission.Invalid({
      values: { title: "Hi", notes: "Some notes", priority: "high", notify: "true", count: "x" },
      errors: { count: ["Expected an integer"] }
    })
    const Filled = TodoForm.with(invalid)

    Vitest.expect(Html.render(<Filled.Input name="title" />)).toBe(
      `<input id="new-todo-title" name="title" type="text" value="Hi">`
    )
    Vitest.expect(Html.render(<Filled.Input name="count" type="number" aria-describedby="count-hint" />)).toBe(
      `<input aria-describedby="count-hint new-todo-count-error" aria-invalid="true" id="new-todo-count" name="count" type="number" value="x">`
    )
    Vitest.expect(Html.render(<Filled.Error name="count" class="error" />)).toBe(
      `<p class="error" id="new-todo-count-error">Expected an integer</p>`
    )
    Vitest.expect(Html.render(<Filled.Error name="title" />)).toBe("")
    Vitest.expect(Html.render(<Filled.Textarea name="notes" />)).toBe(
      `<textarea id="new-todo-notes" name="notes">Some notes</textarea>`
    )
    Vitest.expect(Html.render(<Filled.Checkbox name="notify" />)).toBe(
      `<input id="new-todo-notify" name="notify" type="checkbox" value="true" checked>`
    )
    Vitest.expect(Html.render(
      <Filled.Select
        name="priority"
        value="normal"
        options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High" }]}
      />
    )).toBe(
      `<select id="new-todo-priority" name="priority">` +
        `<option value="normal">Normal</option>` +
        `<option value="high" selected>High</option>` +
      `</select>`
    )
  })

  Vitest.it("shows the form's own errors and describes the form with them", () => {
    const Filled = TodoForm.with(new Submission.Invalid({
      values: { title: "Hi" },
      formErrors: ["The list is full."]
    }))

    Vitest.expect(Html.render(
      <Filled.Root aria-describedby="intro">
        <Filled.Error role="alert" />
      </Filled.Root>
    )).toBe(
      `<form aria-describedby="intro new-todo-error" id="new-todo" method="post" action="/todos">` +
        `<p role="alert" id="new-todo-error">The list is full.</p>` +
      `</form>`
    )
    Vitest.expect(Html.render(<TodoForm.Root><TodoForm.Error /></TodoForm.Root>)).toBe(
      `<form id="new-todo" method="post" action="/todos"></form>`
    )
  })

  Vitest.it("exposes messages for markup the application writes itself", () => {
    const Filled = TodoForm.with(new Submission.Invalid({
      values: {},
      errors: { title: ["Required"], count: [] },
      formErrors: ["Try again"]
    }))

    Vitest.expect(Filled.messages("title")).toEqual(["Required"])
    Vitest.expect(Filled.messages()).toEqual(["Try again"])
    Vitest.expect(Filled.hasErrors("title")).toBe(true)
    Vitest.expect(Filled.hasErrors("count")).toBe(false)
    Vitest.expect(Filled.hasErrors()).toBe(true)
    Vitest.expect(Filled.invalid).toBe(true)

    Vitest.expect(TodoForm.messages("title")).toEqual([])
    Vitest.expect(TodoForm.invalid).toBe(false)
    const fieldOnly = TodoForm.with(new Submission.Invalid({ values: {}, errors: { title: ["Required"] } }))
    Vitest.expect(fieldOnly.hasErrors()).toBe(false)
    Vitest.expect(fieldOnly.invalid).toBe(true)
  })

  Vitest.it("renders messages with the application's markup, keeping the id", () => {
    const Filled = TodoForm.with(new Submission.Invalid({
      values: {},
      errors: { title: ["Required", "Too short"] }
    }))

    Vitest.expect(Html.render(
      <Filled.Error name="title" as="ul" class="errors">
        {(messages) => messages.map((message) => <li>{message}</li>)}
      </Filled.Error>
    )).toBe(`<ul class="errors" id="new-todo-title-error"><li>Required</li><li>Too short</li></ul>`)
  })

  Vitest.it("summarizes every message, linking to each field in schema order", () => {
    const Filled = TodoForm.with(new Submission.Invalid({
      values: {},
      errors: { count: ["Expected an integer"], title: ["Required"] },
      formErrors: ["The list is full."]
    }))

    Vitest.expect(Html.render(<Filled.Summary class="summary" />)).toBe(
      `<div role="alert" tabindex="-1" autofocus class="summary" id="new-todo-summary">` +
        `<h2>There is a problem</h2>` +
        `<ul>` +
          `<li>The list is full.</li>` +
          `<li><a href="#new-todo-title">Required</a></li>` +
          `<li><a href="#new-todo-count">Expected an integer</a></li>` +
        `</ul>` +
      `</div>`
    )
    Vitest.expect(Html.render(<Filled.Summary heading={null} autofocus={false} />)).toBe(
      `<div role="alert" tabindex="-1" id="new-todo-summary">` +
        `<ul>` +
          `<li>The list is full.</li>` +
          `<li><a href="#new-todo-title">Required</a></li>` +
          `<li><a href="#new-todo-count">Expected an integer</a></li>` +
        `</ul>` +
      `</div>`
    )
    Vitest.expect(Html.render(<TodoForm.Summary />)).toBe("")
  })

  Vitest.it("gives hand-built endpoints the same Submission payload", async () => {
    // A form and an endpoint declared separately, sharing the form's payload schema.
    const Signup = Form.make({
      id: "signup",
      action: "/signup",
      payload: Schema.Struct({ email: Schema.String.check(Schema.isPattern(/@/, { message: "Enter an email address" })) })
    })
    const signup = HttpViewEndpoint.post("signup", "/signup", { payload: Signup.payload })
    const api = HttpApi.make("Signup").add(HttpApiGroup.make("signup").add(signup))

    const handlers = HttpApiBuilder.group(api, "signup", (handlers) =>
      handlers.handle("signup", ({ payload }) =>
        Effect.gen(function* () {
          const { email } = yield* payload
          return <p>Welcome, {email}</p>
        }).pipe(
          Effect.catchTag("FormInvalid", (invalid) => {
            const Filled = Signup.with(invalid)
            return Effect.succeed(Html.response(<Filled.Error name="email" />, { status: 422 }))
          })
        )))

    const { dispose, handler } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(api).pipe(
        Layer.provide(handlers),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer))
      ),
      { disableLogger: true }
    )

    try {
      const post = (email: string) => handler(new Request("http://localhost/signup", {
        method: "POST",
        body: new URLSearchParams({ email })
      }))

      const valid = await post("ada@example.com")
      Vitest.expect(valid.status).toBe(200)
      Vitest.expect(await valid.text()).toBe("<p>Welcome, ada@example.com</p>")

      const invalid = await post("ada")
      Vitest.expect(invalid.status).toBe(422)
      Vitest.expect(await invalid.text()).toBe(`<p id="signup-email-error">Enter an email address</p>`)
    } finally {
      await dispose()
    }
  })

  Vitest.it("focuses the first invalid control in schema order when asked", () => {
    const invalid = new Submission.Invalid({
      values: {},
      errors: { count: ["Expected an integer"], notes: ["Too long"] }
    })
    const view = (Filled: typeof TodoForm) => Html.render(
      <Filled.Root>
        <Filled.Input name="title" />
        <Filled.Textarea name="notes" />
        <Filled.Input name="count" type="number" />
      </Filled.Root>
    )

    const focused = view(TodoForm.with(invalid, { focusInvalid: true }))
    Vitest.expect(focused).toContain(`<textarea aria-invalid="true" aria-describedby="new-todo-notes-error" autofocus id="new-todo-notes"`)
    Vitest.expect(focused.match(/autofocus/g)).toHaveLength(1)
    Vitest.expect(view(TodoForm.with(invalid))).not.toContain("autofocus")

    // A control's own autofocus wins
    const Filled = TodoForm.with(invalid, { focusInvalid: true })
    Vitest.expect(Html.render(<Filled.Textarea name="notes" autofocus={false} />)).not.toContain("autofocus")
  })

  Vitest.it("does not refill password inputs", () => {
    const LoginForm = Form.make({
      id: "login",
      action: "/login",
      payload: Schema.Struct({ password: Schema.String })
    })
    const Filled = LoginForm.with(new Submission.Invalid({ values: { password: "secret" }, errors: {} }))

    Vitest.expect(Html.render(<Filled.Input name="password" type="password" />)).toBe(
      `<input id="login-password" name="password" type="password">`
    )
  })

  Vitest.it("keeps the endpoint on derived forms filled with a submission", () => {
    const endpoint = HttpFormEndpoint.make("create", "/contacts", {
      payload: Schema.Struct({ email: Schema.String })
    })
    const ContactForm = Form.derive({ id: "new-contact", endpoint })
    const Filled = ContactForm.with(new Submission.Invalid({ values: { email: "a" }, errors: {} }))

    Vitest.expect(Filled.endpoint).toBe(endpoint)
    Vitest.expect(Html.render(<Filled.Input name="email" />)).toContain(`value="a"`)
  })

  Vitest.it("constrains fields and controls at compile time", () => {
    // @ts-expect-error "missing" is not part of the schema
    const missing = <TodoForm.Input name="missing" />
    // @ts-expect-error title is a string field, not a boolean field
    const wrongControl = <TodoForm.Checkbox name="title" />
    // @ts-expect-error numeric fields require a numeric input type
    const wrongType = <TodoForm.Input name="count" type="email" />
    // @ts-expect-error Root derives its method and action from the form
    const repeatedTransport = <TodoForm.Root method="post" action="/other" />

    Vitest.expect([missing, wrongControl, wrongType, repeatedTransport]).toHaveLength(4)
  })
})
