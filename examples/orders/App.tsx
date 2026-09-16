/** @jsxImportSource effect-views */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import * as Html from "effect-views/Html"
import * as Htmx from "effect-views/Htmx"
import * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"

interface Order {
  readonly id: number
  readonly status: "Active" | "Cancelled"
}

interface OrderOperations {
  readonly get: Effect.Effect<Order>
  readonly cancel: Effect.Effect<Order>
}

class Orders extends Context.Service<Orders, OrderOperations>()("example/Orders") {}

const OrdersLive = Layer.effect(
  Orders,
  Effect.gen(function* () {
    const state = yield* Ref.make<Order>({ id: 42, status: "Active" })
    return Orders.of({
      get: Ref.get(state),
      cancel: Ref.updateAndGet(state, (order) => ({ ...order, status: "Cancelled" }))
    })
  })
)

const OrderParams = {
  orderId: Schema.Int
}

const showOrder = HttpViewEndpoint.get("show", "/orders/:orderId", {
  params: OrderParams
})

const cancelOrder = HttpViewEndpoint.post("cancel", "/orders/:orderId/cancel", {
  params: OrderParams
})

export const api = HttpApi.make("Example").add(
  HttpApiGroup.make("orders")
    .add(showOrder)
    .add(cancelOrder)
)

const OrderView = ({ order }: { readonly order: Order }): Html.Html => (
  <article id={`order-${order.id}`} aria-live="polite">
    <h1>Order #{order.id}</h1>
    <p>Status: <strong>{order.status}</strong></p>
    {order.status === "Active" && (
      <form
        method="post"
        action={`/orders/${order.id}/cancel`}
        hx-post={`/orders/${order.id}/cancel`}
        hx-target={`#order-${order.id}`}
        hx-swap="outerHTML"
      >
        <button type="submit">Cancel order</button>
      </form>
    )}
  </article>
)

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Effect Views</title>
      <script src="https://unpkg.com/htmx.org@2.0.8"></script>
    </head>
    <body>
      <main>{children}</main>
    </body>
  </html>
)

const representation = (
  request: Parameters<typeof Htmx.isRequest>[0],
  order: Order
): Html.Html => {
  const view = <OrderView order={order} />
  return Htmx.isRequest(request) ? view : <Page>{view}</Page>
}

const OrdersHandlers = HttpApiBuilder.group(
  api,
  "orders",
  Effect.fnUntraced(function* (handlers) {
    const orders = yield* Orders
    return handlers
      .handle("show", ({ request }) =>
        Effect.map(orders.get, (order) => representation(request, order)))
      .handle("cancel", ({ request }) =>
        Effect.map(orders.cancel, (order) => representation(request, order)))
  })
).pipe(Layer.provide(OrdersLive))

export const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(OrdersHandlers)
)
