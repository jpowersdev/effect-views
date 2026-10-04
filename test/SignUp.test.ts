import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Layer from "effect/Layer"
import * as Etag from "effect/http/Etag"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Vitest from "vitest"

import * as App from "../examples/signup/App.js"
import * as Csrf from "../src/Csrf.js"
import * as Htmx from "../src/Htmx.js"

const makeApp = () => HttpRouter.toWebHandler(
  Layer.mergeAll(
    App.routes.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer))),
    Htmx.varyLayer,
    Csrf.layer()
  ),
  { disableLogger: true }
)

const valid = {
  name: "Grace",
  email: "grace@example.com",
  password: "correct horse battery",
  confirmation: "correct horse battery",
  age: "36",
  plan: "team",
  newsletter: "true",
  terms: "true"
}

const summaryItems = (body: string) =>
  [...(body.match(/<div[^>]*id="sign-up-summary"[^>]*>.*?<\/ul><\/div>/)?.[0] ?? "").matchAll(/<li>(.*?)<\/li>/g)]
    .map(([, item]) => item)

Vitest.describe("sign-up example", () => {
  Vitest.it("shows a form without a summary", async () => {
    const { dispose, handler } = makeApp()
    try {
      const page = await handler(new Request("http://localhost/"))
      Vitest.expect(page.status).toBe(200)
      const body = await page.text()
      Vitest.expect(body).toMatch(/^<!doctype html>/)
      Vitest.expect(body).toContain('<form novalidate')
      Vitest.expect(body).not.toContain("sign-up-summary")
      Vitest.expect(body).toContain('<option value="personal" selected>Personal</option>')
    } finally {
      await dispose()
    }
  })

  Vitest.it("summarizes every problem with an empty form, in order, linking to each field", async () => {
    const { dispose, handler } = makeApp()
    try {
      const response = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ name: "", email: "", password: "", confirmation: "", age: "", plan: "personal" })
      }))
      Vitest.expect(response.status).toBe(422)
      const body = await response.text()
      Vitest.expect(body).toContain('<div role="alert" tabindex="-1" autofocus class="summary" id="sign-up-summary"><h2>There is a problem</h2>')
      Vitest.expect(summaryItems(body)).toEqual([
        '<a href="#sign-up-name">Enter your name</a>',
        '<a href="#sign-up-email">Enter your email address</a>',
        '<a href="#sign-up-password">Choose a password</a>',
        '<a href="#sign-up-confirmation">Enter your password again</a>',
        '<a href="#sign-up-age">Enter your age</a>',
        '<a href="#sign-up-terms">Accept the terms to continue</a>'
      ])
      Vitest.expect(body).toContain('<div class="field field--invalid"><label for="sign-up-name">')
      Vitest.expect(body).toContain('aria-describedby="email-hint sign-up-email-error"')
    } finally {
      await dispose()
    }
  })

  Vitest.it("uses the schema's messages for invalid values and rules across fields", async () => {
    const { dispose, handler } = makeApp()
    try {
      const wrong = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ ...valid, email: "grace", password: "short", confirmation: "short", age: "thirty" })
      }))
      Vitest.expect(summaryItems(await wrong.text())).toEqual([
        '<a href="#sign-up-email">Enter an email address like name@example.com</a>',
        '<a href="#sign-up-password">Use at least 12 characters</a>',
        '<a href="#sign-up-age">Enter your age in years, 13 or over</a>'
      ])

      const mismatch = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ ...valid, confirmation: "something else entirely" })
      }))
      const mismatchBody = await mismatch.text()
      Vitest.expect(summaryItems(mismatchBody)).toEqual([
        '<a href="#sign-up-confirmation">The passwords do not match</a>'
      ])
      Vitest.expect(mismatchBody).toContain('<p class="error" id="sign-up-confirmation-error">The passwords do not match</p>')

      const young = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ ...valid, age: "14" })
      }))
      Vitest.expect(young.status).toBe(422)
      const youngBody = await young.text()
      Vitest.expect(youngBody).toMatch(/^<main id="sign-up-page">/)
      Vitest.expect(summaryItems(youngBody)).toEqual(["Team plans are for people aged 16 and over"])
      Vitest.expect(youngBody).toContain('aria-describedby="sign-up-error"')
    } finally {
      await dispose()
    }
  })

  Vitest.it("shows rules across fields alongside the fields' own messages", async () => {
    const { dispose, handler } = makeApp()
    try {
      const response = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ ...valid, name: "", confirmation: "something else entirely", age: "14", terms: "" })
      }))
      Vitest.expect(summaryItems(await response.text())).toEqual([
        "Team plans are for people aged 16 and over",
        '<a href="#sign-up-name">Enter your name</a>',
        '<a href="#sign-up-confirmation">The passwords do not match</a>',
        '<a href="#sign-up-terms">Accept the terms to continue</a>'
      ])

      // Until the password itself is valid, the passwords are not compared.
      const short = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ ...valid, password: "short", confirmation: "different" })
      }))
      Vitest.expect(summaryItems(await short.text())).toEqual([
        '<a href="#sign-up-password">Use at least 12 characters</a>'
      ])
    } finally {
      await dispose()
    }
  })

  Vitest.it("rejects a taken email address, keeping what was entered except passwords", async () => {
    const { dispose, handler } = makeApp()
    try {
      const response = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ ...valid, email: "ADA@example.com" })
      }))
      Vitest.expect(response.status).toBe(422)
      const body = await response.text()
      Vitest.expect(summaryItems(body)).toEqual([
        '<a href="#sign-up-email">There is already an account for ADA@example.com. Sign in instead.</a>'
      ])
      Vitest.expect(body).toContain('value="Grace"')
      Vitest.expect(body).toContain('value="36"')
      Vitest.expect(body).toContain('<option value="team" selected>Team</option>')
      Vitest.expect(body).toMatch(/name="newsletter" type="checkbox" value="true" checked>/)
      Vitest.expect(body).not.toContain("correct horse battery")
    } finally {
      await dispose()
    }
  })

  Vitest.it("creates the account and sends the browser to it", async () => {
    const { dispose, handler } = makeApp()
    try {
      const plain = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        body: new URLSearchParams({ ...valid, newsletter: "" })
      }))
      Vitest.expect(plain.status).toBe(303)
      Vitest.expect(plain.headers.get("location")).toBe("/accounts/2")

      const welcome = await handler(new Request("http://localhost/accounts/2"))
      const welcomeBody = await welcome.text()
      Vitest.expect(welcomeBody).toContain("Welcome, Grace")
      Vitest.expect(welcomeBody).not.toContain("newsletter is on its way")

      const htmx = await handler(new Request("http://localhost/sign-up", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ ...valid, email: "linus@example.com" })
      }))
      Vitest.expect(htmx.status).toBe(204)
      Vitest.expect(htmx.headers.get("hx-redirect")).toBe("/accounts/3")
    } finally {
      await dispose()
    }
  })
})
