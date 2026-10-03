/** @jsxImportSource effect-views */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"

import * as Deferred from "effect-views/Deferred"
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
  /** Deliberately slow, to show a deferred fragment. */
  readonly activity: Effect.Effect<ReadonlyArray<string>>
}

class Orders extends Context.Service<Orders, OrderOperations>()("example/Orders") {}

const OrdersLive = Layer.effect(
  Orders,
  Effect.gen(function* () {
    const state = yield* Ref.make<Order>({ id: 42, status: "Active" })
    const events = yield* Ref.make<ReadonlyArray<string>>(["Order placed"])
    return Orders.of({
      get: Ref.get(state),
      cancel: Effect.gen(function* () {
        const order = yield* Ref.get(state)
        if (order.status === "Active") yield* Ref.update(events, (items) => [...items, "Order cancelled"])
        return yield* Ref.updateAndGet(state, (current): Order => ({ ...current, status: "Cancelled" }))
      }),
      activity: Effect.andThen(Effect.sleep("400 millis"), Ref.get(events))
    })
  })
)

const OrderParams = {
  orderId: Schema.Int
}

const listOrders = HttpViewEndpoint.get("list", "/")

const showOrder = HttpViewEndpoint.get("show", "/orders/:orderId", {
  params: OrderParams
})

const cancelOrder = HttpViewEndpoint.post("cancel", "/orders/:orderId/cancel", {
  params: OrderParams
})

const orderActivity = HttpViewEndpoint.get("activity", "/orders/:orderId/activity", {
  params: OrderParams
})

const Activity = Deferred.derive({ endpoint: orderActivity, element: "section" })

export const api = HttpApi.make("Example").add(
  HttpApiGroup.make("orders")
    .add(listOrders)
    .add(showOrder)
    .add(cancelOrder)
    .add(orderActivity)
)

const OrdersIndex = ({ order }: { readonly order: Order }): Html.Html => (
  <section id="orders">
    <h1>Orders</h1>
    <p>This example serves complete pages and swaps focused fragments with htmx.</p>
    <ul>
      <li>
        <a href={`/orders/${order.id}`}>Order #{order.id}</a>
        {" — "}<strong>{order.status}</strong>
      </li>
    </ul>
  </section>
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
    <Activity.Root params={{ orderId: order.id }} aria-busy="true">
      <h2>Activity</h2>
      <p>Loading activity…</p>
      <noscript><a href={Activity.url({ params: { orderId: order.id } })}>View activity</a></noscript>
    </Activity.Root>
  </article>
)

// An async component: an Effect that loads its own data and returns Html.
// Its services and errors stay in the type, unlike a component inside JSX.
const ActivityPanel = Effect.gen(function* () {
  const orders = yield* Orders
  const events = yield* orders.activity
  return (
    <section>
      <h2>Activity</h2>
      <ol>{events.map((event) => <li>{event}</li>)}</ol>
    </section>
  )
})

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Orders</title>
      <script src="https://unpkg.com/htmx.org@2.0.8"></script>
    </head>
    <body>
      <header><a href="/">Orders</a></header>
      <main>{children}</main>
    </body>
  </html>
)

const representation = (
  request: Parameters<typeof Htmx.isRequest>[0],
  view: Html.Html
): Html.Html => Htmx.isRequest(request) ? view : <Page>{view}</Page>

const OrdersHandlers = HttpApiBuilder.group(
  api,
  "orders",
  Effect.fnUntraced(function* (handlers) {
    const orders = yield* Orders
    return handlers
      .handle("list", ({ request }) =>
        Effect.map(orders.get, (order) => representation(request, <OrdersIndex order={order} />)))
      .handle("show", ({ request }) =>
        Effect.map(orders.get, (order) => representation(request, <OrderView order={order} />)))
      .handle("cancel", ({ request }) =>
        Effect.map(orders.cancel, (order) => representation(request, <OrderView order={order} />)))
      .handle("activity", ({ request }) =>
        ActivityPanel.pipe(
          Effect.map((panel) => representation(request, panel)),
          Effect.provideService(Orders, orders)
        ))
  })
).pipe(Layer.provide(OrdersLive))

export const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(OrdersHandlers)
)
