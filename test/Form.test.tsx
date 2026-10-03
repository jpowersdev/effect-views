/** @jsxImportSource effect-views */

import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as Form from "../src/Form.js"
import * as Html from "../src/Html.js"
import * as HttpFormEndpoint from "../src/HttpFormEndpoint.js"
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
      `<input aria-invalid="true" aria-describedby="count-hint new-todo-count-error" id="new-todo-count" name="count" type="number" value="x">`
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
