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

import * as Assets from "effect-views/Assets"
import * as ErrorPage from "effect-views/ErrorPage"
import * as Form from "effect-views/Form"
import * as Html from "effect-views/Html"
import * as HttpFormEndpoint from "effect-views/HttpFormEndpoint"
import * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"
import * as LiveComponent from "effect-views/LiveComponent"
import * as Page from "effect-views/Page"
import * as View from "effect-views/View"

import * as Lines from "./Lines.js"
import { OrderLinesHandlers } from "./Lines.browser.js"

interface Order {
  readonly id: number
  readonly status: "Active" | "Cancelled"
  readonly lines: ReadonlyArray<Lines.Line>
}

class OrderNotFound extends Data.TaggedError("OrderNotFound")<{
  readonly orderId: number
}> {}

interface OrderOperations {
  readonly list: Effect.Effect<ReadonlyArray<Order>>
  readonly get: (orderId: number) => Effect.Effect<Order, OrderNotFound>
  readonly place: (lines: ReadonlyArray<Lines.Line>) => Effect.Effect<Order>
  readonly cancel: (orderId: number) => Effect.Effect<Order, OrderNotFound>
  /** Deliberately slow, to show a deferred fragment. */
  readonly activity: (orderId: number) => Effect.Effect<ReadonlyArray<string>, OrderNotFound>
}

class Orders extends Context.Service<Orders, OrderOperations>()("example/Orders") {}

const OrdersLive = Layer.effect(
  Orders,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<Order>>([
      { id: 42, status: "Active", lines: [{ product: "mug", quantity: 2 }] }
    ])
    const events = yield* Ref.make<ReadonlyMap<number, ReadonlyArray<string>>>(new Map([[42, ["Order placed"]]]))

    const get = (orderId: number) =>
      Effect.flatMap(Ref.get(state), (orders) => {
        const order = orders.find((order) => order.id === orderId)
        return order === undefined ? Effect.fail(new OrderNotFound({ orderId })) : Effect.succeed(order)
      })

    const record = (orderId: number, event: string) =>
      Ref.update(events, (all) => new Map(all).set(orderId, [...(all.get(orderId) ?? []), event]))

    return Orders.of({
      list: Ref.get(state),
      get,
      place: (lines) =>
        Effect.gen(function* () {
          const orders = yield* Ref.get(state)
          const order: Order = { id: Math.max(...orders.map((order) => order.id)) + 1, status: "Active", lines }
          yield* Ref.set(state, [...orders, order])
          yield* record(order.id, "Order placed")
          return order
        }),
      cancel: (orderId) =>
        Effect.gen(function* () {
          const order = yield* get(orderId)
          if (order.status === "Active") yield* record(orderId, "Order cancelled")
          const cancelled: Order = { ...order, status: "Cancelled" }
          yield* Ref.update(state, (orders) => orders.map((order) => order.id === orderId ? cancelled : order))
          return cancelled
        }),
      activity: (orderId) =>
        get(orderId).pipe(
          Effect.andThen(Effect.sleep("400 millis")),
          Effect.andThen(Effect.map(Ref.get(events), (all) => all.get(orderId) ?? []))
        )
    })
  })
)

const OrderParams = {
  orderId: Schema.Int
}

const listOrders = HttpViewEndpoint.get("list", "/")

const newOrder = HttpViewEndpoint.get("new", "/orders/new")

const placeOrder = HttpFormEndpoint.make("place", "/orders", {
  payload: Schema.Struct({ lines: Lines.LinesField })
})

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
const NewOrder = View.derive({ endpoint: newOrder })
const OrderPage = View.derive({ endpoint: showOrder })
const Activity = View.derive({ endpoint: orderActivity })

export const api = HttpApi.make("Example").add(
  HttpApiGroup.make("orders")
    .add(listOrders)
    .add(newOrder)
    .add(placeOrder)
    .add(...LiveComponent.endpoints(Lines.OrderLines))
    .add(showOrder)
    .add(cancelOrder)
    .add(orderActivity)
).add(Assets.group)

const OrdersIndex = ({ orders }: { readonly orders: ReadonlyArray<Order> }): Html.Html => (
  <section id="orders">
    <h1>Orders</h1>
    <p>This example serves complete pages, and the effect-views runtime puts focused fragments into them.</p>
    <ul>
      {orders.map((order) => (
        <li>
          <OrderPage.Link params={{ orderId: order.id }}>Order #{order.id}</OrderPage.Link>
          {" — "}<strong>{order.status}</strong>
        </li>
      ))}
      <li><OrderPage.Link params={{ orderId: 7 }}>Order #7</OrderPage.Link> (missing)</li>
    </ul>
    <p><NewOrder.Link>Place a new order</NewOrder.Link></p>
  </section>
)

const NewOrderView = ({ problem }: { readonly problem?: string | undefined }): Html.Html => (
  <section>
    <h1>New order</h1>
    <p>The items are a live component that runs in the browser: the totals change as you edit them.</p>
    {problem !== undefined && <p role="alert">{problem}</p>}
    <form method="post" action="/orders">
      <Lines.View state={Lines.LinesState.initial} />
      <button type="submit">Place order</button>
    </form>
  </section>
)

const OrderView = ({ order }: { readonly order: Order }): Html.Html => (
  <article id={`order-${order.id}`} aria-live="polite">
    <h1>Order #{order.id}</h1>
    <p>Status: <strong>{order.status}</strong></p>
    <Lines.Summary lines={order.lines} />
    {order.status === "Active" && (
      <form method="post" action={`/orders/${order.id}/cancel`} {...Form.target(`#order-${order.id}`)}>
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

const Document = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Orders</title>
      <Assets.Head errorTarget="#errors" />
    </head>
    <body>
      <header><Home.Link>Orders</Home.Link></header>
      <div id="errors" role="alert"></div>
      <main>{children}</main>
    </body>
  </html>
)

// Views on their own for the runtime, inside the page for everything else
const page = Page.layout(Document)

const NotFound = ({ orderId }: { readonly orderId: number }): Html.Html => (
  <section>
    <h1>Order #{orderId} not found</h1>
    <p><Home.Link>Back to orders</Home.Link></p>
  </section>
)

// An expected error, handled where it happens and shown with a 404 status.
const notFound = (request: Parameters<typeof Page.wantsFragment>[0]) => (error: OrderNotFound) =>
  Effect.succeed(page(request, <NotFound orderId={error.orderId} />, { status: 404 }))

const OrdersHandlers = HttpApiBuilder.group(
  api,
  "orders",
  Effect.fnUntraced(function* (handlers) {
    const orders = yield* Orders
    return yield* handlers
      .handle("list", ({ request }) =>
        Effect.map(orders.list, (items) => page(request, <OrdersIndex orders={items} />)))
      .handle("new", ({ request }) => Effect.succeed(page(request, <NewOrderView />)))
      .handle("place", ({ payload, request }) =>
        Effect.gen(function* () {
          const { lines } = yield* payload
          const order = yield* orders.place(lines)
          return Html.seeOther(`/orders/${order.id}`)
        }).pipe(
          Effect.catchTag("FormInvalid", () =>
            Effect.succeed(page(request, <NewOrderView problem="Check the items and try again." />, { status: 422 })))
        ))
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
      .pipe(LiveComponent.handle(Lines.OrderLines))
  })
).pipe(Layer.provide([OrdersLive, OrderLinesHandlers]))

export const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide([OrdersHandlers, Assets.groupLayer(api)])
)

const statusMessages: Readonly<Record<number, string>> = {
  400: "That request was not understood.",
  403: "That request was blocked.",
  404: "There is nothing here."
}

/** Pages for unexpected failures and unknown routes; fragments for the runtime. */
export const errorPages = ErrorPage.layer(({ fragment, status }) => {
  const message = statusMessages[status] ?? "Something went wrong. Please try again."
  return fragment
    ? <p>{message}</p>
    : <Document><h1>{status === 404 ? "Not found" : "Error"}</h1><p>{message}</p></Document>
})
