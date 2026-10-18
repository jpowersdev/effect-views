/** @jsxImportSource effect-views */

import { css } from "effect-views/Component"
import * as LiveComponent from "effect-views/LiveComponent"
import * as On from "effect-views/On"
import type * as Submission from "effect-views/Submission"

import * as Todo from "../Domain/Todo.js"
import * as Views from "./Views.js"

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
export const View = LiveComponent.view(Views.TitleField, {
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
export const stateFor = (invalid: Submission.Invalid | undefined): Views.TitleState => {
  if (invalid === undefined) return Views.TitleState.empty
  const title = invalid.values["title"]
  return new Views.TitleState({
    title: typeof title === "string" ? title : "",
    problem: invalid.errors["title"]?.[0] ?? "",
    checking: false
  })
}
