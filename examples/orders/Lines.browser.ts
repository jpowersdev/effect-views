/**
 * The order form's line items, handled in the browser: effect-views bundles
 * this module, and what it imports, when the server starts. Nothing here
 * talks to the server; the form submits the items when the order is placed.
 */
import * as LiveComponent from "effect-views/LiveComponent"

import { LinesState, products, View } from "./Lines.js"

export const OrderLinesHandlers = LiveComponent.browser(View, {
  add: (state) =>
    state.update((s) => {
      // Something not ordered yet, if there is anything left
      const product = products.find(({ id }) => !s.lines.some((line) => line.product === id)) ?? products[0]!
      return new LinesState({
        lines: [...s.lines, { key: s.nextKey, product: product.id, quantity: 1 }],
        nextKey: s.nextKey + 1
      })
    }),
  remove: (state, { key }) =>
    state.update((s) =>
      s.lines.length === 1 ? s : new LinesState({ ...s, lines: s.lines.filter((line) => line.key !== key) })
    ),
  choose: (state, { key, product }) =>
    state.update((s) =>
      new LinesState({ ...s, lines: s.lines.map((line) => line.key === key ? { ...line, product } : line) })
    ),
  quantity: (state, { key, quantity }) =>
    state.update((s) =>
      new LinesState({ ...s, lines: s.lines.map((line) => line.key === key ? { ...line, quantity } : line) })
    )
})
