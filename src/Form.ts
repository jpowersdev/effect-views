import type * as Schema from "effect/Schema"

import * as Html from "./Html.js"
import * as HttpFormEndpoint from "./HttpFormEndpoint.js"
import * as Submission from "./Submission.js"

type FieldName<Fields extends Schema.Struct.Fields> = Extract<keyof Fields, string>
type FieldType<Fields extends Schema.Struct.Fields, Name extends FieldName<Fields>> =
  Exclude<Fields[Name]["Type"], null | undefined>

type NamesMatching<Fields extends Schema.Struct.Fields, Value> = {
  [Name in FieldName<Fields>]: FieldType<Fields, Name> extends Value ? Name : never
}[FieldName<Fields>]

export type TextFieldName<Fields extends Schema.Struct.Fields> = NamesMatching<Fields, string>
export type InputFieldName<Fields extends Schema.Struct.Fields> = NamesMatching<Fields, string | number | bigint>
export type CheckboxFieldName<Fields extends Schema.Struct.Fields> = NamesMatching<Fields, boolean>
export type SelectFieldName<Fields extends Schema.Struct.Fields> = NamesMatching<Fields, string | number | bigint>

type NativeAttributes<Reserved extends string> = Omit<Html.Attributes, Reserved | "children"> & {
  readonly children?: Html.Child
}

export interface RootProps extends NativeAttributes<"action" | "id" | "method"> {
  readonly action?: never
  readonly id?: never
  readonly method?: never
}

export interface LabelProps<Name extends string> extends NativeAttributes<"for" | "htmlFor" | "name"> {
  readonly name: Name
}

export type TextInputType =
  | "color"
  | "date"
  | "datetime-local"
  | "email"
  | "hidden"
  | "month"
  | "password"
  | "search"
  | "tel"
  | "text"
  | "time"
  | "url"
  | "week"

export type NumericInputType = "number" | "range"

type InputTypeProps<Value> = Value extends number | bigint
  ? { readonly type: NumericInputType }
  : { readonly type?: TextInputType }

export type InputProps<
  Fields extends Schema.Struct.Fields,
  Name extends InputFieldName<Fields>
> = NativeAttributes<"children" | "id" | "name" | "type"> &
  { readonly name: Name } &
  InputTypeProps<FieldType<Fields, Name>>

export type TextareaProps<Name extends string> = NativeAttributes<"id" | "name"> & {
  readonly name: Name
}

export type CheckboxProps<Name extends string> = NativeAttributes<"children" | "id" | "name" | "type" | "value"> & {
  readonly name: Name
}

export interface SelectOption {
  readonly value: string
  readonly label: Html.Child
  readonly disabled?: boolean
}

export type SelectProps<Name extends string> = NativeAttributes<"id" | "name" | "value"> & {
  readonly name: Name
  /** Rendered as option elements, so a submitted value can be selected again. */
  readonly options?: ReadonlyArray<SelectOption>
  /** The initially selected option value, when options is given. */
  readonly value?: string
}

export type ErrorProps<Name extends string> = Omit<Html.Attributes, "children" | "id" | "name"> & {
  /** The field whose messages to show; without it, the form's own messages. */
  readonly name?: Name
  /** The element holding the messages, which carries the id. Defaults to "p". */
  readonly as?: string
  /** Renders the messages inside the element. Defaults to joining them with spaces. */
  readonly children?: (messages: ReadonlyArray<string>) => Html.Child
}

export type SummaryProps = Omit<Html.Attributes, "children" | "id"> & {
  /** Shown above the list, in an h2. Defaults to "There is a problem"; null for none. */
  readonly heading?: Html.Child
}

export interface Config<Fields extends Schema.Struct.Fields, Action extends string> {
  /** Stable prefix used for the form and control IDs. */
  readonly id: string
  /** Concrete URL submitted to with POST. */
  readonly action: Action
  /** Flat Struct schema used to decode the submitted form payload. */
  readonly payload: Schema.Struct<Fields>
  /** Rules about the decoded values; see Submission.Rules. */
  readonly rules?: Submission.Rules<NoInfer<Schema.Struct<Fields>["Type"]>> | undefined
}

export interface DeriveConfig<Endpoint extends HttpFormEndpoint.Any> {
  readonly id: string
  readonly endpoint: Endpoint
}

export interface Form<Fields extends Schema.Struct.Fields, Action extends string = string> {
  readonly schema: Schema.Struct<Fields>
  /**
   * The payload schema for the endpoint that receives this form. Its handler
   * gets a Submission, so invalid input reaches it instead of failing earlier.
   */
  readonly payload: ReturnType<typeof Submission.schema<Fields>>
  readonly id: string
  readonly action: Action
  readonly idFor: <Name extends FieldName<Fields>>(name: Name) => string
  readonly Root: (props: RootProps) => Html.Html
  readonly Label: <Name extends FieldName<Fields>>(props: LabelProps<Name>) => Html.Html
  readonly Input: <Name extends InputFieldName<Fields>>(props: InputProps<Fields, Name>) => Html.Html
  readonly Textarea: <Name extends TextFieldName<Fields>>(props: TextareaProps<Name>) => Html.Html
  readonly Checkbox: <Name extends CheckboxFieldName<Fields>>(props: CheckboxProps<Name>) => Html.Html
  readonly Select: <Name extends SelectFieldName<Fields>>(props: SelectProps<Name>) => Html.Html
  /**
   * A field's error messages, or the form's own messages without a name, or
   * nothing when there are none. Controls and the form refer to it with
   * aria-describedby.
   */
  readonly Error: <Name extends FieldName<Fields>>(props: ErrorProps<Name>) => Html.Html
  /**
   * Every message, the form's own first and then each field's, linking to its
   * control. Renders nothing for a valid form. It has role="alert" and autofocus,
   * so the browser moves focus to it on a full page load and htmx after a swap.
   */
  readonly Summary: (props: SummaryProps) => Html.Html
  /** A field's messages, or the form's own messages without a name. */
  readonly messages: <Name extends FieldName<Fields>>(name?: Name) => ReadonlyArray<string>
  /** Whether a field has messages, or the form has its own without a name. */
  readonly hasErrors: <Name extends FieldName<Fields>>(name?: Name) => boolean
  /** Whether there are any messages at all, for the form or any field. */
  readonly invalid: boolean
  /** Rejects a decoded submission with messages, keeping its values for the form. */
  readonly reject: (value: Schema.Struct<Fields>["Type"], messages: Submission.Messages) => Submission.Invalid
  /**
   * The same form, filled with an invalid submission's values and errors.
   * Password inputs are left empty.
   */
  readonly with: (state: Submission.Invalid | undefined, options?: WithOptions) => Form<Fields, Action>
}

export interface WithOptions {
  /**
   * Gives the first control with errors, in schema order, autofocus, so the
   * browser focuses it after a full page load and htmx after a swap. Screen
   * readers then read its label and error. For forms without a Summary, which
   * takes focus itself.
   */
  readonly focusInvalid?: boolean
}

export interface DerivedForm<
  Fields extends Schema.Struct.Fields,
  Action extends string,
  Endpoint extends HttpFormEndpoint.Any
> extends Omit<Form<Fields, Action>, "with"> {
  readonly endpoint: Endpoint
  readonly with: (state: Submission.Invalid | undefined, options?: WithOptions) => DerivedForm<Fields, Action, Endpoint>
}

const validateId = (id: string): void => {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    throw new TypeError(`Invalid form id: ${id}`)
  }
}

const fieldId = (formId: string, name: string): string => {
  const field = name.replace(/[^A-Za-z0-9_-]+/g, "-")
  return `${formId}-${field}`
}

const firstValue = (value: string | ReadonlyArray<string> | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0]

const joinIds = (...ids: ReadonlyArray<unknown>): string | undefined => {
  const joined = ids.filter((id) => typeof id === "string" && id !== "").join(" ")
  return joined === "" ? undefined : joined
}

/**
 * Binds control names and some control types to a Struct schema, with IDs for labels.
 * The application supplies layout, validation attributes, and error presentation.
 */
export const make = <
  const Fields extends Schema.Struct.Fields,
  const Action extends string
>(
  config: Config<Fields, Action>
): Form<Fields, Action> => {
  const { action, id, payload: schema, rules } = config
  validateId(id)
  const payload = Submission.schema(schema, { rules })

  const idFor = <Name extends FieldName<Fields>>(name: Name): string => fieldId(id, name)
  const errorIdFor = (name: string): string => `${fieldId(id, name)}-error`
  const formErrorId = `${id}-error`

  const build = (state: Submission.Invalid | undefined, options?: WithOptions): Form<Fields, Action> => {
    const valueOf = (name: string) => firstValue(state?.values[name])
    const errorsOf = (name: string) => state?.errors[name] ?? []

    // Fields in schema order, then any others a handler reported
    const fieldsWithErrors = (): ReadonlyArray<string> => {
      const names = Object.keys(state?.errors ?? {}).filter((name) => errorsOf(name).length > 0)
      const order = Object.keys(schema.fields)
      return [...order.filter((name) => names.includes(name)), ...names.filter((name) => !order.includes(name))]
    }

    const focusTarget = options?.focusInvalid === true ? fieldsWithErrors()[0] : undefined

    // aria-invalid and aria-describedby for a control whose field has errors, and
    // autofocus for the first of them when asked, unless the control sets its own
    const validity = (name: string, props: Html.Attributes) => {
      const describedBy = props["aria-describedby"]
      if (errorsOf(name).length === 0) return { "aria-describedby": describedBy }
      return {
        "aria-invalid": "true",
        "aria-describedby": joinIds(describedBy, errorIdFor(name)),
        ...(name === focusTarget && !Object.hasOwn(props, "autofocus") ? { autofocus: true } : {})
      }
    }

    const Root = (props: RootProps): Html.Html => {
      const { "aria-describedby": describedBy, children, ...attributes } = props
      const formErrors = state?.formErrors ?? []
      return Html.element("form", {
        ...attributes,
        "aria-describedby": formErrors.length === 0 ? describedBy : joinIds(describedBy, formErrorId),
        id,
        method: "post",
        action,
        children
      })
    }

    const Label = <Name extends FieldName<Fields>>(props: LabelProps<Name>): Html.Html => {
      const { children, name, ...attributes } = props
      return Html.element("label", { ...attributes, for: idFor(name), children })
    }

    const Input = <Name extends InputFieldName<Fields>>(props: InputProps<Fields, Name>): Html.Html => {
      const { name, type = "text", value, ...attributes } = props
      const submitted = type === "password" ? undefined : valueOf(name)
      return Html.element("input", {
        ...attributes,
        ...validity(name, props),
        id: idFor(name),
        name,
        type,
        value: submitted ?? value
      })
    }

    const Textarea = <Name extends TextFieldName<Fields>>(props: TextareaProps<Name>): Html.Html => {
      const { children, name, ...attributes } = props
      const submitted = valueOf(name)
      return Html.element("textarea", {
        ...attributes,
        ...validity(name, props),
        id: idFor(name),
        name,
        children: submitted ?? children
      })
    }

    const Checkbox = <Name extends CheckboxFieldName<Fields>>(props: CheckboxProps<Name>): Html.Html => {
      const { checked, name, ...attributes } = props
      return Html.element("input", {
        ...attributes,
        ...validity(name, props),
        id: idFor(name),
        name,
        type: "checkbox",
        value: "true",
        checked: state === undefined ? checked : valueOf(name) === "true"
      })
    }

    const Select = <Name extends SelectFieldName<Fields>>(props: SelectProps<Name>): Html.Html => {
      const { children, name, options, value, ...attributes } = props
      const selected = valueOf(name) ?? value
      return Html.element("select", {
        ...attributes,
        ...validity(name, props),
        id: idFor(name),
        name,
        children: options === undefined ? children : options.map((option) =>
          Html.element("option", {
            value: option.value,
            selected: option.value === selected,
            disabled: option.disabled,
            children: option.label
          })
        )
      })
    }

    const messages = <Name extends FieldName<Fields>>(name?: Name): ReadonlyArray<string> =>
      name === undefined ? state?.formErrors ?? [] : errorsOf(name)

    const hasErrors = <Name extends FieldName<Fields>>(name?: Name): boolean => messages(name).length > 0

    const invalid = hasErrors() || fieldsWithErrors().length > 0

    const Error = <Name extends FieldName<Fields>>(props: ErrorProps<Name>): Html.Html => {
      const { as = "p", children, name, ...attributes } = props
      const list = messages(name)
      if (list.length === 0) return Html.fragment()
      return Html.element(as, {
        ...attributes,
        id: name === undefined ? formErrorId : errorIdFor(name),
        children: children === undefined ? list.join(" ") : children(list)
      })
    }

    const Summary = (props: SummaryProps): Html.Html => {
      if (!invalid) return Html.fragment()
      const { heading = "There is a problem", ...attributes } = props
      const items = [
        ...messages().map((message) => Html.element("li", { children: message })),
        ...fieldsWithErrors().flatMap((name) =>
          errorsOf(name).map((message) =>
            Html.element("li", {
              children: Html.element("a", { href: `#${fieldId(id, name)}`, children: message })
            })
          )
        )
      ]
      return Html.element("div", {
        role: "alert",
        tabindex: "-1",
        autofocus: true,
        ...attributes,
        id: `${id}-summary`,
        children: [
          heading === null || heading === undefined ? null : Html.element("h2", { children: heading }),
          Html.element("ul", { children: items })
        ]
      })
    }

    return Object.freeze({
      schema,
      payload,
      id,
      action,
      idFor,
      Root,
      Label,
      Input,
      Textarea,
      Checkbox,
      Select,
      Error,
      Summary,
      messages,
      hasErrors,
      invalid,
      reject: (value: Schema.Struct<Fields>["Type"], messages: Submission.Messages) =>
        Submission.reject(schema, value, messages),
      with: build
    })
  }

  return build(undefined)
}

/**
 * Copies an HttpFormEndpoint's path and field schema into a form.
 * Requires the original endpoint metadata and a path without parameters.
 */
export const derive = <const Endpoint extends HttpFormEndpoint.Any>(
  config: DeriveConfig<Endpoint>
): DerivedForm<HttpFormEndpoint.Fields<Endpoint>, Endpoint["path"], Endpoint> => {
  const { endpoint, id } = config
  const form = make({
    id,
    action: endpoint.path,
    payload: HttpFormEndpoint.getPayload(endpoint),
    rules: HttpFormEndpoint.getRules(endpoint)
  })

  const bind = (bound: Form<HttpFormEndpoint.Fields<Endpoint>, Endpoint["path"]>) =>
    Object.freeze({
      ...bound,
      endpoint,
      with: (state: Submission.Invalid | undefined, options?: WithOptions) => bind(bound.with(state, options))
    })

  return bind(form)
}
