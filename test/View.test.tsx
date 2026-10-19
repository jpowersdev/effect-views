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

  Vitest.it("renders placeholders that the runtime replaces with the view", () => {
    Vitest.expect(Html.render(
      <Activity.Lazy params={{ orderId: 42 }} query={{ limit: 5 }} class="panel" aria-busy="true">
        <p>Loading activity…</p>
      </Activity.Lazy>
    )).toBe(
      `<div class="panel" aria-busy="true" data-load="{&quot;url&quot;:&quot;/orders/42/activity?limit=5&quot;,&quot;when&quot;:&quot;load&quot;,&quot;swap&quot;:&quot;outer&quot;}">` +
        `<p>Loading activity…</p>` +
      `</div>`
    )
    Vitest.expect(Html.render(<Stats.Lazy as="section" trigger="visible" swap="inner" />)).toBe(
      `<section data-load="{&quot;url&quot;:&quot;/stats&quot;,&quot;when&quot;:&quot;visible&quot;,&quot;swap&quot;:&quot;inner&quot;}"></section>`
    )
    Vitest.expect(Html.render(<Stats.Lazy trigger={{ every: "5 seconds" }} swap="inner" />)).toBe(
      `<div data-load="{&quot;url&quot;:&quot;/stats&quot;,&quot;when&quot;:{&quot;every&quot;:5000},&quot;swap&quot;:&quot;inner&quot;}"></div>`
    )
  })

  Vitest.it("renders elements that the runtime updates with a view's events", () => {
    Vitest.expect(Html.render(
      <Orders.Subscribe params={{ orderId: 42 }} event={["status", "items"]} as="section" class="live">
        <p>Waiting…</p>
      </Orders.Subscribe>
    )).toBe(
      `<section class="live" data-subscribe="{&quot;url&quot;:&quot;/orders/42/events&quot;,&quot;events&quot;:[&quot;status&quot;,&quot;items&quot;],&quot;swap&quot;:&quot;inner&quot;}">` +
        `<p>Waiting…</p>` +
      `</section>`
    )
    Vitest.expect(Html.render(<Orders.Subscribe params={{ orderId: 42 }} event="items" swap="append" />)).toBe(
      `<div data-subscribe="{&quot;url&quot;:&quot;/orders/42/events&quot;,&quot;events&quot;:[&quot;items&quot;],&quot;swap&quot;:&quot;append&quot;}"></div>`
    )
  })

  Vitest.it("renders one connection for elements that take different events", () => {
    Vitest.expect(Html.render(
      <Orders.Connect params={{ orderId: 42 }} as="main" class="order">
        <p {...Orders.event("status")}>Waiting…</p>
        <ul {...Orders.event("items")}></ul>
      </Orders.Connect>
    )).toBe(
      `<main class="order" data-subscribe="{&quot;url&quot;:&quot;/orders/42/events&quot;,&quot;swap&quot;:&quot;inner&quot;}">` +
        `<p data-event="status">Waiting…</p><ul data-event="items"></ul>` +
      `</main>`
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
      // @ts-expect-error the URL comes from the endpoint
      <Stats.Lazy data-load="{}" />,
      // @ts-expect-error the runtime loads a placeholder once, when visible, or every so often
      <Stats.Lazy trigger="revealed" />,
      // @ts-expect-error params are required by the endpoint
      Activity.url(),
      // @ts-expect-error the URL comes from the endpoint
      <Orders.Subscribe params={{ orderId: 42 }} event="status" data-subscribe="{}" />,
      // @ts-expect-error params are required by the endpoint
      <Orders.Connect />,
      // @ts-expect-error the elements inside take the events
      <Orders.Connect params={{ orderId: 42 }} data-event="status" />
    ]

    Vitest.expect(invalid).toBeTypeOf("function")
  })
})
