import * as Html from "./Html.js"

export type Component<Props = Record<string, unknown>> = (props: Props) => Html.Html
export type ElementType = string | Component<any>

export const Fragment = (props: { readonly children?: Html.Child }): Html.Html =>
  Html.fragment(props.children)

export const jsx = (
  type: ElementType,
  props: Html.Attributes | null,
  _key?: string | number
): Html.Html => {
  if (typeof type === "function") return type(props ?? {})
  return Html.element(type, props)
}

export const jsxs = jsx
export const jsxDEV = jsx

export namespace JSX {
  export type Element = Html.Html
  export type ElementType = string | Component<any>

  export interface ElementChildrenAttribute {
    readonly children: {}
  }

  export interface IntrinsicAttributes {
    readonly key?: string | number
  }

  export interface IntrinsicElements {
    readonly [name: string]: Html.Attributes
  }
}
