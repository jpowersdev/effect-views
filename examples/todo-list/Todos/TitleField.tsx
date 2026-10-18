/** @jsxImportSource effect-views */

// The title field: its contract and its markup. They are kept apart from
// Views.ts, which declares the server's endpoints, because everything this
// module imports is bundled for the browser.

import * as Schema from "effect/Schema"

import { css } from "effect-views/Component"
import * as LiveAction from "effect-views/LiveAction"
import * as LiveComponent from "effect-views/LiveComponent"
import * as On from "effect-views/On"
import type * as Submission from "effect-views/Submission"

import * as Todo from "../Domain/Todo.js"

/** What the title field renders from, in the browser: what was typed, and what is wrong with it. */
export class TitleState extends Schema.Class<TitleState>("TitleState")({
  title: Schema.String,
  /** The first problem with the title, empty while it is fine or before anything is typed. */
  problem: Schema.String,
  /** Whether the list is being checked for the title. */
  checking: Schema.Boolean
}) {
  static readonly empty = new TitleState({ title: "", problem: "", checking: false })
}

/** Runs as you type. A newer keystroke interrupts the run before it, along with its request. */
export const edit = LiveAction.make("edit", {
  payload: { title: Schema.String },
  concurrency: "switch"
})

/**
 * The new todo's title, checked as you type with the form's own schema, then
 * against the list. It runs in the browser, with the handlers in
 * TitleField.browser.ts; its endpoint is in the group in Views.ts.
 */
export const TitleField = LiveComponent.make("todo-title", { state: TitleState, runs: "browser" })
  .add(edit)

const style = css`
  :scope { display: block; }
  input[aria-invalid] { border: 2px solid #b3261e; }
  .status { margin: 0.25rem 0; color: #555; min-height: 1.25em; }
  .status--problem { color: #b3261e; }
`

/**
 * The title field's markup. The server renders it first, inside the form; the
 * browser renders it again with each change, keeping the caret where it is.
 */
export const View = LiveComponent.view(TitleField, {
  style,
  render: (state, actions) => (
    <>
      <label for="todo-title-input">What needs doing?</label>{" "}
      <input
        id="todo-title-input"
        name="title"
        type="text"
        autocomplete="off"
        required
        value={state.title}
        aria-invalid={state.problem === "" ? undefined : "true"}
        aria-describedby="todo-title-status"
        autofocus={state.problem !== ""}
        {...On.input(actions.edit({ title: On.value }))}
      />
      <p
        id="todo-title-status"
        class={state.problem === "" ? "status" : "status status--problem"}
        aria-live="polite"
      >
        {state.problem !== ""
          ? state.problem
          : state.checking
          ? "Checking the list…"
          : state.title.trim() === ""
          ? ""
          : `${Todo.maxTitleLength - state.title.trim().length} characters left`}
      </p>
    </>
  )
})

/** The field as the server last saw it: empty, or as submitted with the problem the server found. */
export const stateFor = (invalid: Submission.Invalid | undefined): TitleState => {
  if (invalid === undefined) return TitleState.empty
  const title = invalid.values["title"]
  return new TitleState({
    title: typeof title === "string" ? title : "",
    problem: invalid.errors["title"]?.[0] ?? "",
    checking: false
  })
}
