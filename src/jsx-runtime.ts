import * as Html from "./Html.js"

export type Component<Props = Record<string, unknown>> = (props: Props, key?: string | number) => Html.Html
export type ElementType = string | Component<any>

export const Fragment = (props: { readonly children?: Html.Child }): Html.Html =>
  Html.fragment(props.children)

export const jsx = (
  type: ElementType,
  props: Html.Attributes | null,
  key?: string | number
): Html.Html => {
  // Components given a key put it on their own element, such as Component.make's, for the browser runtime
  if (typeof type === "function") return type(props ?? {}, key)
  return Html.element(type, key === undefined ? props : { ...props, key })
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
