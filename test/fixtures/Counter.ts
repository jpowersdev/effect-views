// A live component that runs on the server, for the browser tests.
import * as Schema from "effect/Schema"

import * as Html from "../../src/Html.js"
import * as LiveAction from "../../src/LiveAction.js"
import * as LiveComponent from "../../src/LiveComponent.js"
import * as On from "../../src/On.js"

export class CounterState extends Schema.Class<CounterState>("CounterState")({
  count: Schema.Int,
  query: Schema.String,
  /** How many searches the server ran. */
  searches: Schema.Int,
  notes: Schema.Array(Schema.String)
}) {}

export const increment = LiveAction.make("increment")
export const add = LiveAction.make("add", { payload: { by: Schema.Int } })
export const search = LiveAction.make("search", { payload: { query: Schema.String }, debounce: "150 millis" })
/** Adds the note typed, and renders the field empty again. */
export const note = LiveAction.make("note", { payload: { note: Schema.String } })

export const Counter = LiveComponent.make("test-server-counter", { state: CounterState })
  .add(increment)
  .add(add)
  .add(search)
  .add(note)

export const View = LiveComponent.view(Counter, {
  render: (state, actions) =>
    Html.fragment(
      Html.element("output", { id: "count", children: String(state.count) }),
      Html.element("button", { id: "increment", type: "button", ...On.click(actions.increment()), children: "+" }),
      Html.element("button", { id: "add-five", type: "button", ...On.click(actions.add({ by: 5 })), children: "+5" }),
      Html.element("input", { id: "query", name: "query", value: state.query, ...On.input(actions.search()) }),
      Html.element("p", { id: "searched", children: `${state.searches}: ${state.query}` }),
      // A submit button: clicking it runs the action instead of submitting the form
      Html.element("form", {
        id: "notes",
        action: "/nowhere",
        children: [
          Html.element("input", { id: "note", name: "note", value: "" }),
          Html.element("button", { id: "add-note", ...On.click(actions.note()), children: "Add" })
        ]
      }),
      Html.element("ul", { id: "note-list", children: state.notes.map((text) => Html.element("li", { children: text })) })
    )
})
