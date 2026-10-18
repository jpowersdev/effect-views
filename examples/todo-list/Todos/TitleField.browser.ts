/**
 * The title field's handlers. They run in the browser: effect-views bundles
 * this module, and what it imports, when the server starts.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpApiClient from "effect/http-api/HttpApiClient"

import * as LiveComponent from "effect-views/LiveComponent"
import * as Submission from "effect-views/Submission"

import * as DataApi from "../DataApi.js"
import * as Todo from "../Domain/Todo.js"
import * as TitleField from "./TitleField.js"
import { TitleState } from "./Views.js"

/** The JSON API's client, typed by the contract the server implements. Requests go to the page's own origin. */
const client = HttpApiClient.make(DataApi.Api)

/** The title's first problem, from the same decoding the server gives the submitted form, with its messages. */
const problemWith = (title: string): string | undefined => {
  const decoded = Submission.decode(Todo.CreateTodo, { title })
  if (Exit.isSuccess(decoded)) return undefined
  const invalid = Cause.squash(decoded.cause) as Submission.Invalid
  return invalid.errors["title"]?.[0] ?? invalid.formErrors[0] ?? "Check the title"
}

export const TitleFieldHandlers = LiveComponent.browser(TitleField.View, {
  edit: (state, { title }) =>
    Effect.gen(function* () {
      const problem = problemWith(title)
      yield* state.update((s) =>
        new TitleState({ ...s, title, problem: problem ?? "", checking: problem === undefined })
      )
      if (problem !== undefined) return
      // Wait for a pause in typing: the next keystroke interrupts this run, here or during the request
      yield* Effect.sleep("300 millis")
      const { todosApi } = yield* client
      const todos = yield* todosApi.list()
      const taken = todos.some((todo) => todo.title === title.trim())
      yield* state.update((s) =>
        new TitleState({ ...s, checking: false, problem: taken ? "That is already on the list" : "" })
      )
    }).pipe(
      // The server checks again when the form is submitted, so a failed check only stops the spinner
      Effect.catch(() => state.update((s) => new TitleState({ ...s, checking: false })))
    )
}, { layer: FetchHttpClient.layer })
