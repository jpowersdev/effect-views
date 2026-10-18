// A live component that runs in the browser, for the tests. Written without
// JSX, because the bundler reads it from source when Assets.layer is built.
import * as Schema from "effect/Schema"

import * as Html from "../../src/Html.js"
import * as LiveAction from "../../src/LiveAction.js"
import * as LiveComponent from "../../src/LiveComponent.js"
import * as On from "../../src/On.js"

export class ToggleState extends Schema.Class<ToggleState>("ToggleState")({
  on: Schema.Boolean,
  label: Schema.String,
  count: Schema.Int
}) {}

export const toggle = LiveAction.make("toggle")
export const rename = LiveAction.make("rename", { payload: { label: Schema.String }, concurrency: "switch" })
export const add = LiveAction.make("add", { payload: { by: Schema.Int } })

export const Toggle = LiveComponent.make("test-toggle", { state: ToggleState, runs: "browser" })
  .add(toggle)
  .add(rename)
  .add(add)

export const View = LiveComponent.view(Toggle, {
  render: (state, actions) =>
    Html.fragment(
      Html.element("button", {
        type: "button",
        "aria-pressed": String(state.on),
        ...On.click(actions.toggle()),
        children: state.label
      }),
      Html.element("input", { value: state.label, ...On.input(actions.rename({ label: On.value })) }),
      Html.element("button", { type: "button", ...On.click(actions.add({ by: 5 })), children: String(state.count) }),
      Html.element("input", {
        ...On.keydown({ ArrowUp: actions.add({ by: 1 }), ArrowDown: actions.add({ by: -1 }), Enter: undefined })
      })
    )
})
