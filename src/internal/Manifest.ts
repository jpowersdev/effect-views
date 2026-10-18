/**
 * The parts of Assets that modules running in the browser also import, such as
 * Component and LiveComponent. Unlike Assets.ts, nothing here needs Node.
 */
import * as Context from "effect/Context"
import * as Fiber from "effect/Fiber"

import type * as Html from "../Html.js"

/** What a component contributes to the shared stylesheet; see Component.make. */
export interface Definition {
  readonly tag: string
  /** Styles, already scoped to the component's element. */
  readonly style: string | undefined
}

const definitions = new Map<string, Definition>()

/** @internal Called by Component.make. */
export const register = (definition: Definition): void => {
  if (definitions.has(definition.tag)) {
    throw new TypeError(`A component is already defined as <${definition.tag}>`)
  }
  definitions.set(definition.tag, definition)
}

/** @internal The components defined so far, in the order they were defined. */
export const registered = (): ReadonlyArray<Definition> => [...definitions.values()]

export interface File {
  readonly path: string
  readonly contentType: string
  readonly body: Uint8Array
}

/** Where a live component that runs in the browser loads its code from. */
export interface LiveModule {
  /** The module that defines the component's browser handlers. */
  readonly module: string
  /** Every module it imports, for <link rel="modulepreload">. */
  readonly preloads: ReadonlyArray<string>
}

export interface Manifest {
  /** Where the files are served, such as "/assets". */
  readonly prefix: `/${string}`
  /** Tags for the page head: the stylesheet and the scripts. */
  readonly head: Html.Html
  /** The stylesheets and the scripts the head loads, in order. */
  readonly stylesheets: ReadonlyArray<string>
  readonly scripts: ReadonlyArray<string>
  /** Module scripts the head loads, such as the effect-views runtime, and the modules they import. */
  readonly modules: ReadonlyArray<string>
  readonly modulePreloads: ReadonlyArray<string>
  /** Where the application's own files are served, by name; see Options.files and url. */
  readonly urls: ReadonlyMap<string, string>
  /** Files served by Assets.layer, by path. */
  readonly files: ReadonlyMap<string, File>
  /** Components whose styles the files include. */
  readonly components: ReadonlySet<string>
  /** Live components that run in the browser, by tag. */
  readonly live: ReadonlyMap<string, LiveModule>
}

/** The assets built when Assets.layer started, available while handling each request. */
export class Assets extends Context.Service<Assets, Manifest>()("effect-views/Assets") {}

/** The assets for the request being handled, if Assets.layer is in use. */
export const current = (): Manifest | undefined => {
  const fiber = Fiber.getCurrent()
  return fiber === undefined ? undefined : Context.getOrUndefined(fiber.context, Assets)
}
