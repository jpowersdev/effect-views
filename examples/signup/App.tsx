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

import * as Form from "effect-views/Form"
import * as Html from "effect-views/Html"
import * as Htmx from "effect-views/Htmx"
import * as HttpFormEndpoint from "effect-views/HttpFormEndpoint"
import * as HttpViewEndpoint from "effect-views/HttpViewEndpoint"
import * as Submission from "effect-views/Submission"

// Domain ---------------------------------------------------------------------

const plans = [
  { value: "personal", label: "Personal" },
  { value: "team", label: "Team" }
] as const

/** Every message is written here, next to the rule it explains. */
export const SignUp = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1, { message: "Enter your name" }))
    .annotateKey({ messageMissingKey: "Enter your name" }),
  email: Schema.Trim.check(
    Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, { message: "Enter an email address like name@example.com" })
  ).annotateKey({ messageMissingKey: "Enter your email address" }),
  password: Schema.String.check(Schema.isMinLength(12, { message: "Use at least 12 characters" }))
    .annotateKey({ messageMissingKey: "Choose a password" }),
  confirmation: Schema.String.annotateKey({ messageMissingKey: "Enter your password again" }),
  // The message also covers text that is not a number.
  age: Schema.Int.check(Schema.isGreaterThanOrEqualTo(13))
    .annotate({ message: "Enter your age in years, 13 or over" })
    .annotateKey({ messageMissingKey: "Enter your age" }),
  plan: Schema.Literals(["personal", "team"]).annotate({ message: "Choose a plan" })
    .annotateKey({ messageMissingKey: "Choose a plan" }),
  // An unchecked box is submitted as nothing, which reads as false.
  newsletter: Schema.Boolean,
  // A box that must be checked
  terms: Schema.Literal(true).annotateKey({ messageMissingKey: "Accept the terms to continue" })
}).check(
  // A rule about two fields, shown on the one to fix
  Schema.makeFilter(({ confirmation, password }) =>
    password === confirmation ? undefined : { path: ["confirmation"], issue: "The passwords do not match" }
  ),
  // A rule about the form as a whole
  Schema.makeFilter(({ age, plan }) =>
    plan === "team" && age < 16 ? "Team plans are for people aged 16 and over" : undefined
  )
)

interface Account {
  readonly id: number
  readonly name: string
  readonly email: string
  readonly plan: "personal" | "team"
  readonly newsletter: boolean
}

class EmailTaken extends Data.TaggedError("EmailTaken")<{ readonly email: string }> {}
class AccountNotFound extends Data.TaggedError("AccountNotFound")<{ readonly id: number }> {}

interface AccountOperations {
  readonly create: (signUp: typeof SignUp.Type) => Effect.Effect<Account, EmailTaken>
  readonly get: (id: number) => Effect.Effect<Account, AccountNotFound>
}

class Accounts extends Context.Service<Accounts, AccountOperations>()("example/Accounts") {}

const AccountsLive = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const accounts = yield* Ref.make<ReadonlyArray<Account>>([
      { id: 1, name: "Ada", email: "ada@example.com", plan: "personal", newsletter: false }
    ])

    return Accounts.of({
      create: ({ email, name, newsletter, plan }) =>
        Effect.flatMap(Ref.get(accounts), (existing) => {
          if (existing.some((account) => account.email.toLowerCase() === email.toLowerCase())) {
            return Effect.fail(new EmailTaken({ email }))
          }
          const account: Account = { id: existing.length + 1, name, email, plan, newsletter }
          return Effect.as(Ref.set(accounts, [...existing, account]), account)
        }),
      get: (id) =>
        Effect.flatMap(Ref.get(accounts), (existing) => {
          const account = existing.find((item) => item.id === id)
          return account === undefined ? Effect.fail(new AccountNotFound({ id })) : Effect.succeed(account)
        })
    })
  })
)

// Contract -------------------------------------------------------------------

const showForm = HttpViewEndpoint.get("form", "/")

const signUp = HttpFormEndpoint.make("signUp", "/sign-up", { payload: SignUp })

const welcome = HttpViewEndpoint.get("welcome", "/accounts/:id", {
  params: { id: Schema.Int }
})

export const api = HttpApi.make("SignUp").add(
  HttpApiGroup.make("signUp")
    .add(showForm)
    .add(signUp)
    .add(welcome)
)

// Views ----------------------------------------------------------------------

const SignUpForm = Form.derive({ id: "sign-up", endpoint: signUp })

const Field = ({ children, invalid }: { readonly children: Html.Child; readonly invalid: boolean }): Html.Html => (
  <div class={invalid ? "field field--invalid" : "field"}>{children}</div>
)

const SignUpView = ({ invalid }: { readonly invalid?: Submission.Invalid | undefined }): Html.Html => {
  const F = SignUpForm.with(invalid)
  return (
    <main id="sign-up-page">
      <h1>Create an account</h1>
      {/* novalidate lets the server's messages, rather than the browser's, explain every problem at once */}
      <F.Root novalidate hx-boost="true" hx-push-url="false" hx-target="#sign-up-page" hx-swap="outerHTML">
        <F.Summary class="summary" />

        <Field invalid={F.hasErrors("name")}>
          <F.Label name="name">Name</F.Label>
          <F.Input name="name" autocomplete="name" required />
          <F.Error name="name" class="error" />
        </Field>

        <Field invalid={F.hasErrors("email")}>
          <F.Label name="email">Email address</F.Label>
          <p id="email-hint" class="hint">We only use it to sign you in.</p>
          <F.Input name="email" type="email" autocomplete="email" aria-describedby="email-hint" required />
          <F.Error name="email" class="error" />
        </Field>

        <Field invalid={F.hasErrors("password")}>
          <F.Label name="password">Password</F.Label>
          <F.Input name="password" type="password" autocomplete="new-password" required />
          <F.Error name="password" class="error" />
        </Field>

        <Field invalid={F.hasErrors("confirmation")}>
          <F.Label name="confirmation">Password again</F.Label>
          <F.Input name="confirmation" type="password" autocomplete="new-password" required />
          <F.Error name="confirmation" class="error" />
        </Field>

        <Field invalid={F.hasErrors("age")}>
          <F.Label name="age">Age</F.Label>
          <F.Input name="age" type="number" inputmode="numeric" min={13} required />
          <F.Error name="age" class="error" />
        </Field>

        <Field invalid={F.hasErrors("plan")}>
          <F.Label name="plan">Plan</F.Label>
          <F.Select name="plan" value="personal" options={plans} />
          <F.Error name="plan" class="error" />
        </Field>

        <Field invalid={F.hasErrors("newsletter")}>
          <F.Checkbox name="newsletter" />
          <F.Label name="newsletter">Send me the monthly newsletter</F.Label>
        </Field>

        <Field invalid={F.hasErrors("terms")}>
          <F.Checkbox name="terms" required />
          <F.Label name="terms">I accept the terms of service</F.Label>
          <F.Error name="terms" class="error" />
        </Field>

        <button type="submit">Create account</button>
      </F.Root>
    </main>
  )
}

const WelcomeView = ({ account }: { readonly account: Account }): Html.Html => (
  <main id="sign-up-page">
    <h1>Welcome, {account.name}</h1>
    <p>
      Your {account.plan} account for {account.email} is ready.
      {account.newsletter ? " The newsletter is on its way." : ""}
    </p>
    <p><a href="/">Create another account</a></p>
  </main>
)

const styles = `
  :root { color-scheme: light dark; --accent: #2f5bd3; --danger: #c0352b; --muted: #6b7280; --line: #d1d5db; }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 0 auto; padding: 2rem 1.25rem; }
  h1 { font-size: 1.75rem; margin: 0 0 1.5rem; }
  .field { margin-bottom: 1.25rem; }
  label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
  input:not([type="checkbox"]), select {
    width: 100%; padding: 0.6rem 0.75rem; font: inherit;
    border: 1px solid var(--line); border-radius: 0.5rem; background: transparent; color: inherit;
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  .field--invalid input:not([type="checkbox"]), .field--invalid select { border-color: var(--danger); }
  .field:has(input[type="checkbox"]) { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .field:has(input[type="checkbox"]) label { font-weight: 400; margin: 0; }
  .field:has(input[type="checkbox"]) .error { flex-basis: 100%; }
  input[type="checkbox"] { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }
  .hint { color: var(--muted); font-size: 0.9rem; margin: 0 0 0.35rem; }
  .error { color: var(--danger); font-size: 0.9rem; margin: 0.35rem 0 0; }
  .summary {
    background: color-mix(in srgb, var(--danger) 8%, transparent);
    border-left: 4px solid var(--danger); border-radius: 0.5rem;
    padding: 0.9rem 1rem; margin-bottom: 1.75rem;
  }
  .summary:focus { outline: 2px solid var(--danger); outline-offset: 2px; }
  .summary h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  .summary ul { margin: 0; padding-left: 1.1rem; }
  .summary li { margin: 0.15rem 0; }
  .summary a { color: var(--danger); text-underline-offset: 2px; }
  button {
    width: 100%; padding: 0.75rem; font: inherit; font-weight: 600;
    color: white; background: var(--accent); border: 0; border-radius: 0.5rem; cursor: pointer;
  }
`

const Page = ({ children }: { readonly children: Html.Child }): Html.Html => Html.document(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Create an account</title>
      <Htmx.Config />
      <style>{Html.unsafe(styles)}</style>
      <script src="https://unpkg.com/htmx.org@2.0.8"></script>
    </head>
    <body>{children}</body>
  </html>
)

const representation = (request: Parameters<typeof Htmx.isRequest>[0], view: Html.Html): Html.Html =>
  Htmx.isRequest(request) ? view : <Page>{view}</Page>

// Handlers -------------------------------------------------------------------

const SignUpHandlers = HttpApiBuilder.group(
  api,
  "signUp",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* Accounts
    return handlers
      .handle("form", ({ request }) => Effect.succeed(representation(request, <SignUpView />)))
      .handle("signUp", ({ payload, request }) =>
        Effect.gen(function* () {
          const signUp = yield* payload
          const account = yield* accounts.create(signUp).pipe(
            Effect.catchTag("EmailTaken", ({ email }) =>
              Effect.fail(SignUpForm.reject(signUp, {
                errors: { email: [`There is already an account for ${email}. Sign in instead.`] }
              })))
          )
          return Htmx.seeOther(request, `/accounts/${account.id}`)
        }).pipe(
          Effect.catchTag("FormInvalid", (invalid) =>
            Effect.succeed(Html.response(representation(request, <SignUpView invalid={invalid} />), { status: 422 })))
        ))
      .handle("welcome", ({ params, request }) =>
        accounts.get(params.id).pipe(
          Effect.map((account) => representation(request, <WelcomeView account={account} />)),
          Effect.catchTag("AccountNotFound", () =>
            Effect.succeed(Html.response(representation(request, <main><h1>No such account</h1></main>), { status: 404 })))
        ))
  })
).pipe(Layer.provide(AccountsLive))

export const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(SignUpHandlers)
)
