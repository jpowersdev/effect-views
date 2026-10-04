/** @jsxImportSource effect-views */

import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as Html from "../src/Html.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"
import * as View from "../src/View.js"

const activity = HttpViewEndpoint.get("activity", "/orders/:orderId/activity", {
  params: { orderId: Schema.Int },
  query: { limit: Schema.optionalKey(Schema.Int) }
})

const Activity = View.derive({ endpoint: activity })

const Stats = View.derive({ endpoint: HttpViewEndpoint.get("stats", "/stats") })

const Orders = View.derive({
  endpoint: HttpViewEndpoint.events("orders", "/orders/:orderId/events", { params: { orderId: Schema.Int } })
})

Vitest.describe("View", () => {
  Vitest.it("builds URLs encoded by the endpoint's schemas", () => {
    Vitest.expect(Activity.url({ params: { orderId: 7 }, query: { limit: 5 } })).toBe("/orders/7/activity?limit=5")
    Vitest.expect(Activity.url({ params: { orderId: 7 }, query: {} })).toBe("/orders/7/activity")
    Vitest.expect(Stats.url()).toBe("/stats")
  })

  Vitest.it("renders links", () => {
    Vitest.expect(Html.render(
      <Activity.Link params={{ orderId: 42 }} query={{}} class="activity">Activity</Activity.Link>
    )).toBe(`<a href="/orders/42/activity" class="activity">Activity</a>`)
    Vitest.expect(Html.render(<Stats.Link>Stats</Stats.Link>)).toBe(`<a href="/stats">Stats</a>`)
  })

  Vitest.it("renders placeholders that htmx replaces with the view", () => {
    Vitest.expect(Html.render(
      <Activity.Lazy params={{ orderId: 42 }} query={{ limit: 5 }} class="panel" aria-busy="true">
        <p>Loading activity…</p>
      </Activity.Lazy>
    )).toBe(
      `<div class="panel" aria-busy="true" hx-get="/orders/42/activity?limit=5" hx-trigger="load" hx-swap="outerHTML">` +
        `<p>Loading activity…</p>` +
      `</div>`
    )
    Vitest.expect(Html.render(<Stats.Lazy as="section" trigger="revealed" swap="innerHTML" />)).toBe(
      `<section hx-get="/stats" hx-trigger="revealed" hx-swap="innerHTML"></section>`
    )
  })

  Vitest.it("renders elements that htmx updates with a view's events", () => {
    Vitest.expect(Html.render(
      <Orders.Subscribe params={{ orderId: 42 }} event="status, items" as="section" class="live">
        <p>Waiting…</p>
      </Orders.Subscribe>
    )).toBe(
      `<section class="live" hx-ext="sse" sse-connect="/orders/42/events" sse-swap="status, items">` +
        `<p>Waiting…</p>` +
      `</section>`
    )
  })

  Vitest.it("constrains params and query at compile time", () => {
    // Not called: invalid input would also be rejected by the schema at runtime.
    const invalid = () => [
      // @ts-expect-error params are required by the endpoint
      <Activity.Link query={{}} />,
      // @ts-expect-error orderId is an integer
      <Activity.Lazy params={{ orderId: "42" }} query={{}} />,
      // @ts-expect-error href comes from the endpoint
      <Stats.Link href="/elsewhere" />,
      // @ts-expect-error hx-get comes from the endpoint
      <Stats.Lazy hx-get="/elsewhere" />,
      // @ts-expect-error params are required by the endpoint
      Activity.url(),
      // @ts-expect-error sse-connect comes from the endpoint
      <Orders.Subscribe params={{ orderId: 42 }} event="status" sse-connect="/elsewhere" />
    ]

    Vitest.expect(invalid).toBeTypeOf("function")
  })
})
