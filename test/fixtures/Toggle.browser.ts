// The test component's browser handlers: Assets.layer bundles this file.
import * as LiveComponent from "../../src/LiveComponent.js"

import { ToggleState, View } from "./Toggle.js"

export const ToggleHandlers = LiveComponent.browser(View, {
  toggle: (state) => state.update((s) => new ToggleState({ ...s, on: !s.on })),
  rename: (state, { label }) => state.update((s) => new ToggleState({ ...s, label })),
  add: (state, { by }) => state.update((s) => new ToggleState({ ...s, count: s.count + by }))
})
