/** @jsxImportSource effect-views */

// The order form's line items: what can be ordered, and a live component that
// edits the items in the browser. The server imports this module to render
// the form and check what it receives; the browser imports it to render the
// items again as they change. It imports nothing the browser cannot run.

import * as Schema from "effect/Schema"

import { css } from "effect-views/Component"
import * as Html from "effect-views/Html"
import * as LiveAction from "effect-views/LiveAction"
import * as LiveComponent from "effect-views/LiveComponent"
import * as On from "effect-views/On"

export const ProductId = Schema.Literals(["mug", "tee", "cap", "tote"])
export type ProductId = typeof ProductId.Type

export interface Product {
  readonly id: ProductId
  readonly name: string
  /** In cents. */
  readonly price: number
}

export const products: ReadonlyArray<Product> = [
  { id: "mug", name: "Enamel mug", price: 1400 },
  { id: "tee", name: "T-shirt", price: 2200 },
  { id: "cap", name: "Cap", price: 1800 },
  { id: "tote", name: "Tote bag", price: 1600 }
]

const priceOf = (id: ProductId): number => products.find((product) => product.id === id)?.price ?? 0

export const formatPrice = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

export const Quantity = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 }))

export const Line = Schema.Struct({ product: ProductId, quantity: Quantity })
export type Line = typeof Line.Type

export const totalOf = (lines: ReadonlyArray<Line>): number =>
  lines.reduce((total, line) => total + priceOf(line.product) * line.quantity, 0)

/** The items as the form submits them: one field, holding them as JSON. */
export const LinesField = Schema.fromJsonString(Schema.NonEmptyArray(Line))

/** The items being edited, each with a key that stays with it as others are added or removed. */
export class LinesState extends Schema.Class<LinesState>("LinesState")({
  lines: Schema.Array(Schema.Struct({ key: Schema.Int, product: ProductId, quantity: Quantity })),
  nextKey: Schema.Int
}) {
  static readonly initial = new LinesState({ lines: [{ key: 1, product: "mug", quantity: 1 }], nextKey: 2 })
}

export const add = LiveAction.make("add")
export const remove = LiveAction.make("remove", { payload: { key: Schema.Int } })
export const choose = LiveAction.make("choose", { payload: { key: Schema.Int, product: ProductId } })
export const quantity = LiveAction.make("quantity", {
  // Read from the input as text; text that is not a whole number from 1 to 99 is ignored
  payload: { key: Schema.Int, quantity: Schema.NumberFromString.pipe(Schema.decodeTo(Quantity)) }
})

/** Edits the order's items in the browser; its handlers are in Lines.browser.ts. */
export const OrderLines = LiveComponent.make("order-lines", { state: LinesState, runs: "browser" })
  .add(add)
  .add(remove)
  .add(choose)
  .add(quantity)

const style = css`
  :scope { display: block; margin: 1rem 0; }
  table { border-collapse: collapse; }
  th, td { padding: 0.25rem 0.5rem; text-align: left; }
  .price { text-align: right; font-variant-numeric: tabular-nums; }
  input[type="number"] { width: 4rem; }
  tfoot th, tfoot td { border-top: 1px solid #ccc; font-weight: bold; }
`

export const View = LiveComponent.view(OrderLines, {
  style,
  render: (state, actions) => (
    <>
      <table>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Quantity</th>
            <th scope="col" class="price">Price</th>
            <th scope="col"><span hidden>Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {state.lines.map((line) => (
            <tr key={line.key}>
              <td>
                <select aria-label="Item" {...On.change(actions.choose({ key: line.key, product: On.value }))}>
                  {products.map((product) => (
                    <option value={product.id} selected={product.id === line.product}>{product.name}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  min="1"
                  max="99"
                  aria-label="Quantity"
                  value={line.quantity}
                  {...On.input(actions.quantity({ key: line.key, quantity: On.value }))}
                />
              </td>
              <td class="price">{formatPrice(priceOf(line.product) * line.quantity)}</td>
              <td>
                <button
                  type="button"
                  disabled={state.lines.length === 1}
                  {...On.click(actions.remove({ key: line.key }))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colspan="2">Total</th>
            <td class="price">{formatPrice(totalOf(state.lines))}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <button type="button" {...On.click(actions.add())}>Add an item</button>
      {/* Submitted with the form around the component */}
      <input
        type="hidden"
        name="lines"
        value={Schema.encodeSync(LinesField)(
          state.lines.map(({ product, quantity }) => ({ product, quantity })) as unknown as readonly [Line, ...Array<Line>]
        )}
      />
    </>
  )
})

/** The items of a placed order. */
export const Summary = ({ lines }: { readonly lines: ReadonlyArray<Line> }): Html.Html => (
  <table>
    <tbody>
      {lines.map((line) => (
        <tr>
          <td>{products.find((product) => product.id === line.product)?.name}</td>
          <td>× {line.quantity}</td>
          <td class="price">{formatPrice(priceOf(line.product) * line.quantity)}</td>
        </tr>
      ))}
    </tbody>
    <tfoot>
      <tr>
        <th scope="row" colspan="2">Total</th>
        <td class="price">{formatPrice(totalOf(lines))}</td>
      </tr>
    </tfoot>
  </table>
)
