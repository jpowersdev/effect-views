import type * as Schema from "effect/Schema"

import * as Html from "./Html.js"
import * as HttpFormEndpoint from "./HttpFormEndpoint.js"
import * as HttpViewEndpoint from "./HttpViewEndpoint.js"
import type * as Submission from "./Submission.js"

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

export type ErrorProps<Name extends string> = NativeAttributes<"id" | "name"> & {
  readonly name: Name
}

export interface Config<Fields extends Schema.Struct.Fields, Action extends string> {
  /** Stable prefix used for the form and control IDs. */
  readonly id: string
  /** Concrete URL submitted to with POST. */
  readonly action: Action
  /** Flat Struct schema used to decode the submitted form payload. */
  readonly payload: Schema.Struct<Fields>
}

export interface DeriveConfig<Endpoint extends HttpFormEndpoint.Any> {
  readonly id: string
  readonly endpoint: Endpoint
}

export interface Form<Fields extends Schema.Struct.Fields, Action extends string = string> {
  readonly schema: Schema.Struct<Fields>
  readonly payload: Schema.Struct<Fields>["Rebuild"]
  readonly id: string
  readonly action: Action
  readonly idFor: <Name extends FieldName<Fields>>(name: Name) => string
  readonly Root: (props: RootProps) => Html.Html
  readonly Label: <Name extends FieldName<Fields>>(props: LabelProps<Name>) => Html.Html
  readonly Input: <Name extends InputFieldName<Fields>>(props: InputProps<Fields, Name>) => Html.Html
  readonly Textarea: <Name extends TextFieldName<Fields>>(props: TextareaProps<Name>) => Html.Html
  readonly Checkbox: <Name extends CheckboxFieldName<Fields>>(props: CheckboxProps<Name>) => Html.Html
  readonly Select: <Name extends SelectFieldName<Fields>>(props: SelectProps<Name>) => Html.Html
  /** A field's error messages, or nothing when it has none. Controls refer to it with aria-describedby. */
  readonly Error: <Name extends FieldName<Fields>>(props: ErrorProps<Name>) => Html.Html
  /**
   * The same form, filled with an invalid submission's values and errors.
   * Password inputs are left empty.
   */
  readonly with: (state: Submission.Invalid | undefined) => Form<Fields, Action>
}

export interface DerivedForm<
  Fields extends Schema.Struct.Fields,
  Action extends string,
  Endpoint extends HttpFormEndpoint.Any
> extends Omit<Form<Fields, Action>, "with"> {
  readonly endpoint: Endpoint
  readonly with: (state: Submission.Invalid | undefined) => DerivedForm<Fields, Action, Endpoint>
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
  const { action, id, payload: schema } = config
  validateId(id)
  const payload = HttpViewEndpoint.form(schema)

  const idFor = <Name extends FieldName<Fields>>(name: Name): string => fieldId(id, name)
  const errorIdFor = (name: string): string => `${fieldId(id, name)}-error`

  const build = (state: Submission.Invalid | undefined): Form<Fields, Action> => {
    const valueOf = (name: string) => firstValue(state?.values[name])
    const errorsOf = (name: string) => state?.errors[name] ?? []

    // aria-invalid and aria-describedby for a control whose field has errors
    const validity = (name: string, describedBy: unknown) =>
      errorsOf(name).length === 0
        ? { "aria-describedby": describedBy }
        : { "aria-invalid": "true", "aria-describedby": joinIds(describedBy, errorIdFor(name)) }

    const Root = (props: RootProps): Html.Html => {
      const { children, ...attributes } = props
      return Html.element("form", {
        ...attributes,
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
      const { "aria-describedby": describedBy, name, type = "text", value, ...attributes } = props
      const submitted = type === "password" ? undefined : valueOf(name)
      return Html.element("input", {
        ...attributes,
        ...validity(name, describedBy),
        id: idFor(name),
        name,
        type,
        value: submitted ?? value
      })
    }

    const Textarea = <Name extends TextFieldName<Fields>>(props: TextareaProps<Name>): Html.Html => {
      const { "aria-describedby": describedBy, children, name, ...attributes } = props
      const submitted = valueOf(name)
      return Html.element("textarea", {
        ...attributes,
        ...validity(name, describedBy),
        id: idFor(name),
        name,
        children: submitted ?? children
      })
    }

    const Checkbox = <Name extends CheckboxFieldName<Fields>>(props: CheckboxProps<Name>): Html.Html => {
      const { "aria-describedby": describedBy, checked, name, ...attributes } = props
      return Html.element("input", {
        ...attributes,
        ...validity(name, describedBy),
        id: idFor(name),
        name,
        type: "checkbox",
        value: "true",
        checked: state === undefined ? checked : valueOf(name) === "true"
      })
    }

    const Select = <Name extends SelectFieldName<Fields>>(props: SelectProps<Name>): Html.Html => {
      const { "aria-describedby": describedBy, children, name, options, value, ...attributes } = props
      const selected = valueOf(name) ?? value
      return Html.element("select", {
        ...attributes,
        ...validity(name, describedBy),
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

    const Error = <Name extends FieldName<Fields>>(props: ErrorProps<Name>): Html.Html => {
      const { name, ...attributes } = props
      const messages = errorsOf(name)
      if (messages.length === 0) return Html.fragment()
      return Html.element("p", { ...attributes, id: errorIdFor(name), children: messages.join(" ") })
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
    payload: HttpFormEndpoint.getPayload(endpoint)
  })

  const bind = (bound: Form<HttpFormEndpoint.Fields<Endpoint>, Endpoint["path"]>) =>
    Object.freeze({
      ...bound,
      endpoint,
      with: (state: Submission.Invalid | undefined) => bind(bound.with(state))
    })

  return bind(form)
}
