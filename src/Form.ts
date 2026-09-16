import type * as Schema from "effect/Schema"

import * as Html from "./Html.js"
import * as HttpFormEndpoint from "./HttpFormEndpoint.js"
import * as HttpViewEndpoint from "./HttpViewEndpoint.js"

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

export type SelectProps<Name extends string> = NativeAttributes<"id" | "name"> & {
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
}

export interface DerivedForm<
  Fields extends Schema.Struct.Fields,
  Action extends string,
  Endpoint extends HttpFormEndpoint.Any
> extends Form<Fields, Action> {
  readonly endpoint: Endpoint
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

  const idFor = <Name extends FieldName<Fields>>(name: Name): string => fieldId(id, name)

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
    const { name, type = "text", ...attributes } = props
    return Html.element("input", { ...attributes, id: idFor(name), name, type })
  }

  const Textarea = <Name extends TextFieldName<Fields>>(props: TextareaProps<Name>): Html.Html => {
    const { children, name, ...attributes } = props
    return Html.element("textarea", { ...attributes, id: idFor(name), name, children })
  }

  const Checkbox = <Name extends CheckboxFieldName<Fields>>(props: CheckboxProps<Name>): Html.Html => {
    const { name, ...attributes } = props
    return Html.element("input", {
      ...attributes,
      id: idFor(name),
      name,
      type: "checkbox",
      value: "true"
    })
  }

  const Select = <Name extends SelectFieldName<Fields>>(props: SelectProps<Name>): Html.Html => {
    const { children, name, ...attributes } = props
    return Html.element("select", { ...attributes, id: idFor(name), name, children })
  }

  return Object.freeze({
    schema,
    payload: HttpViewEndpoint.form(schema),
    id,
    action,
    idFor,
    Root,
    Label,
    Input,
    Textarea,
    Checkbox,
    Select
  })
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

  return Object.freeze({ ...form, endpoint })
}
