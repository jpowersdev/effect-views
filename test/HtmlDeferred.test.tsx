/** @jsxImportSource effect-views */

import * as Schema from "effect/Schema"
import * as Vitest from "vitest"

import * as HtmlDeferred from "../src/HtmlDeferred.js"
import * as Html from "../src/Html.js"
import * as HttpViewEndpoint from "../src/HttpViewEndpoint.js"

const activity = HttpViewEndpoint.get("activity", "/orders/:orderId/activity", {
  params: { orderId: Schema.Int },
  query: { limit: Schema.optionalKey(Schema.Int) }
})

const Activity = HtmlDeferred.derive({ endpoint: activity })

const stats = HttpViewEndpoint.get("stats", "/stats")

const Stats = HtmlDeferred.derive({ endpoint: stats, element: "section" })

Vitest.describe("HtmlDeferred", () => {
  Vitest.it("renders a placeholder that loads the endpoint with htmx", () => {
    const view = (
      <Activity.Root params={{ orderId: 42 }} query={{ limit: 5 }} class="panel" aria-busy="true">
        <p>Loading activity…</p>
      </Activity.Root>
    )

    Vitest.expect(Html.render(view)).toBe(
      `<div class="panel" aria-busy="true" hx-get="/orders/42/activity?limit=5" hx-trigger="load" hx-swap="outerHTML">` +
        `<p>Loading activity…</p>` +
      `</div>`
    )
  })

  Vitest.it("supports custom elements, triggers, and swaps for endpoints without inputs", () => {
    const view = <Stats.Root trigger="revealed" swap="innerHTML" />

    Vitest.expect(Html.render(view)).toBe(
      `<section hx-get="/stats" hx-trigger="revealed" hx-swap="innerHTML"></section>`
    )
  })

  Vitest.it("exposes the URL builder", () => {
    Vitest.expect(Activity.url({ params: { orderId: 7 }, query: {} })).toBe("/orders/7/activity")
    Vitest.expect(Stats.url({})).toBe("/stats")
  })

  Vitest.it("constrains params and query at compile time", () => {
    // Not called: invalid input would also be rejected by the schema at runtime.
    const invalid = () => [
      // @ts-expect-error params are required by the endpoint
      <Activity.Root query={{}} />,
      // @ts-expect-error orderId is an integer
      <Activity.Root params={{ orderId: "42" }} query={{}} />,
      // @ts-expect-error hx-get comes from the endpoint
      <Stats.Root hx-get="/elsewhere" />
    ]

    Vitest.expect(invalid).toBeTypeOf("function")
  })
})
