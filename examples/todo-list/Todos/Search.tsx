/** @jsxImportSource effect-views */

import { css } from "effect-views/Component"
import type * as Html from "effect-views/Html"
import * as LiveComponent from "effect-views/LiveComponent"
import * as On from "effect-views/On"

import * as Views from "./Views.js"

const style = css`
  :scope { display: block; margin: 1rem 0; }
  ul { margin: 0.25rem 0; }
  .none { color: #555; }
`

const Results = ({ state }: { readonly state: Views.SearchState }): Html.Html => {
  if (state.query.trim() === "") return <></>
  if (state.matches.length === 0) return <p class="none">Nothing matches “{state.query}”</p>
  return <ul>{state.matches.map((todo) => <li>{todo.title}</li>)}</ul>
}

/** The search's markup. It needs only the contract in Views.ts, not the handler. */
export const View = LiveComponent.view(Views.Search, {
  style,
  render: (state, actions) => (
    <>
      <label for="todo-search-query">Find a todo</label>{" "}
      <input
        id="todo-search-query"
        type="search"
        name="query"
        value={state.query}
        autocomplete="off"
        {...On.input(actions.search())}
      />
      <Results state={state} />
    </>
  )
})
