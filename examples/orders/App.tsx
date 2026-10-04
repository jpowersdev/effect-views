/** @jsxImportSource effect-views */

import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"

import * as ErrorPage from "effect-views/ErrorPage"
import * as Html from "effect-views/Html"
import * as Htmx from "effect-views/Htmx"
import * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"
import * as View from "effect-views/View"

interface Order {
  readonly id: number
  readonly status: "Active" | "Cancelled"
}

class OrderNotFound extends Data.TaggedError("OrderNotFound")<{
  readonly orderId: number
}> {}

interface OrderOperations {
  readonly list: Effect.Effect<ReadonlyArray<Order>>
  readonly get: (orderId: number) => Effect.Effect<Order, OrderNotFound>
  readonly cancel: (orderId: number) => Effect.Effect<Order, OrderNotFound>
  /** Deliberately slow, to show a deferred fragment. */
  readonly activity: (orderId: number) => Effect.Effect<ReadonlyArray<string>, OrderNotFound>
}

class Orders extends Context.Service<Orders, OrderOperations>()("example/Orders") {}

const OrdersLive = Layer.effect(
  Orders,
  Effect.gen(function* () {
    const state = yield* Ref.make<Order>({ id: 42, status: "Active" })
    const events = yield* Ref.make<ReadonlyArray<string>>(["Order placed"])

    const get = (orderId: number) =>
      Effect.flatMap(Ref.get(state), (order) =>
        order.id === orderId ? Effect.succeed(order) : Effect.fail(new OrderNotFound({ orderId })))

    return Orders.of({
      list: Effect.map(Ref.get(state), (order) => [order]),
      get,
      cancel: (orderId) =>
        Effect.gen(function* () {
          const order = yield* get(orderId)
          if (order.status === "Active") yield* Ref.update(events, (items) => [...items, "Order cancelled"])
          return yield* Ref.updateAndGet(state, (current): Order => ({ ...current, status: "Cancelled" }))
        }),
      activity: (orderId) =>
        get(orderId).pipe(
          Effect.andThen(Effect.sleep("400 millis")),
          Effect.andThen(Ref.get(events))
        )
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

// Typed links and lazy placeholders for the GET views
const Home = View.derive({ endpoint: listOrders })
const OrderPage = View.derive({ endpoint: showOrder })
const Activity = View.derive({ endpoint: orderActivity })

export const api = HttpApi.make("Example").add(
  HttpApiGroup.make("orders")
    .add(listOrders)
    .add(showOrder)
    .add(cancelOrder)
    .add(orderActivity)
)

const OrdersIndex = ({ orders }: { readonly orders: ReadonlyArray<Order> }): Html.Html => (
  <section id="orders">
    <h1>Orders</h1>
    <p>This example serves complete pages and swaps focused fragments with htmx.</p>
    <ul>
      {orders.map((order) => (
        <li>
          <OrderPage.Link params={{ orderId: order.id }}>Order #{order.id}</OrderPage.Link>
          {" — "}<strong>{order.status}</strong>
        </li>
      ))}
      <li><OrderPage.Link params={{ orderId: 7 }}>Order #7</OrderPage.Link> (missing)</li>
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
    <Activity.Lazy as="section" params={{ orderId: order.id }} aria-busy="true">
      <h2>Activity</h2>
      <p>Loading activity…</p>
      <noscript><Activity.Link params={{ orderId: order.id }}>View activity</Activity.Link></noscript>
    </Activity.Lazy>
  </article>
)

// An async component: an Effect that loads its own data and returns Html.
// Its services and errors stay in the type, unlike a component inside JSX.
const ActivityPanel = (orderId: number) =>
  Effect.gen(function* () {
    const orders = yield* Orders
    const events = yield* orders.activity(orderId)
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
      <Htmx.Config errorTarget="#errors" />
      <script src="https://unpkg.com/htmx.org@2.0.8"></script>
    </head>
    <body>
      <header><Home.Link>Orders</Home.Link></header>
      <div id="errors" role="alert"></div>
      <main>{children}</main>
    </body>
  </html>
)

// Views on their own for htmx, inside the page for everything else
const page = Htmx.layout(Page)

const NotFound = ({ orderId }: { readonly orderId: number }): Html.Html => (
  <section>
    <h1>Order #{orderId} not found</h1>
    <p><Home.Link>Back to orders</Home.Link></p>
  </section>
)

// An expected error, handled where it happens and shown with a 404 status.
const notFound = (request: Parameters<typeof Htmx.isRequest>[0]) => (error: OrderNotFound) =>
  Effect.succeed(page(request, <NotFound orderId={error.orderId} />, { status: 404 }))

const OrdersHandlers = HttpApiBuilder.group(
  api,
  "orders",
  Effect.fnUntraced(function* (handlers) {
    const orders = yield* Orders
    return handlers
      .handle("list", ({ request }) =>
        Effect.map(orders.list, (items) => page(request, <OrdersIndex orders={items} />)))
      .handle("show", ({ params, request }) =>
        orders.get(params.orderId).pipe(
          Effect.map((order) => page(request, <OrderView order={order} />)),
          Effect.catchTag("OrderNotFound", notFound(request))
        ))
      .handle("cancel", ({ params, request }) =>
        orders.cancel(params.orderId).pipe(
          Effect.map((order) => page(request, <OrderView order={order} />)),
          Effect.catchTag("OrderNotFound", notFound(request))
        ))
      .handle("activity", ({ params, request }) =>
        ActivityPanel(params.orderId).pipe(
          Effect.map((panel) => page(request, panel)),
          Effect.catchTag("OrderNotFound", notFound(request)),
          Effect.provideService(Orders, orders)
        ))
  })
).pipe(Layer.provide(OrdersLive))

export const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(OrdersHandlers)
)

const statusMessages: Readonly<Record<number, string>> = {
  400: "That request was not understood.",
  403: "That request was blocked.",
  404: "There is nothing here."
}

/** Pages for unexpected failures and unknown routes; fragments for htmx. */
export const errorPages = ErrorPage.layer(({ fragment, status }) => {
  const message = statusMessages[status] ?? "Something went wrong. Please try again."
  return fragment
    ? <p>{message}</p>
    : <Page><h1>{status === 404 ? "Not found" : "Error"}</h1><p>{message}</p></Page>
})
