import * as Assets from "./Assets.js"
import * as Html from "./Html.js"

const CssTypeId: unique symbol = Symbol.for("effect-views/Component/Css") as any

/** Styles for a component, written with the css template tag. */
export interface Css {
  readonly [CssTypeId]: typeof CssTypeId
  readonly value: string
}

/**
 * Styles for a component. Editors highlight CSS in templates tagged `css`.
 * Interpolated values are inserted as they are.
 */
export const css = (strings: TemplateStringsArray, ...values: ReadonlyArray<string | number>): Css => ({
  [CssTypeId]: CssTypeId,
  value: String.raw({ raw: strings }, ...values)
})

export interface Config<Props> {
  /** Styles scoped to the component's element; `:scope` selects the element itself. */
  readonly style?: Css
  /** The element's contents. */
  readonly render: (props: Props) => Html.Html
}

export interface Component<Props> {
  (props: Props): Html.Html
  readonly tag: string
}

const isCustomElementName = (tag: string): boolean => /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(tag)

/**
 * Defines a component: markup rendered inside a custom element, with styles
 * scoped to it. The styles are served by Assets.layer, which must be built
 * after the component is defined.
 *
 * ```tsx
 * export const Card = Component.make("app-card", {
 *   style: css`
 *     :scope { display: block; padding: 1rem; border: 1px solid #ddd; }
 *     h2 { margin-top: 0; }
 *   `,
 *   render: ({ title, children }: { title: string; children: Html.Child }) => (
 *     <>
 *       <h2>{title}</h2>
 *       {children}
 *     </>
 *   )
 * })
 *
 * <Card title="Details">…</Card>
 * ```
 */
export const make = <Props = {}>(tag: string, config: Config<Props>): Component<Props> => {
  if (!isCustomElementName(tag)) {
    throw new TypeError(`A component's tag must be a custom element name, such as "app-menu": ${tag}`)
  }

  Assets.register({
    tag,
    // Stop at other components, whose styles are their own
    style: config.style === undefined ? undefined : `@scope (${tag}) to (:scope [data-component]) {\n${config.style.value}\n}`
  })

  const component = (props: Props): Html.Html => {
    const manifest = Assets.current()
    if (manifest !== undefined && !manifest.components.has(tag)) {
      throw new Error(`<${tag}> was defined after Assets.layer was built; import its module before building the layer`)
    }
    return Html.element(tag, { "data-component": true, children: config.render(props) })
  }

  return Object.assign(component, { tag })
}
