import * as Vm from "node:vm"
import * as Vitest from "vitest"

import * as Minify from "../src/internal/Minify.js"

/** Runs a script and returns its last value, to compare the source with what minifying it gives. */
const evaluate = (code: string): unknown => Vm.runInNewContext(code, {})

/** Minifies the source, checks the output, and checks that both give the same value. */
const expectMinified = (source: string, expected: string) => {
  const minified = Minify.whitespace(source)
  Vitest.expect(minified).toBe(expected)
  Vitest.expect(evaluate(minified)).toEqual(evaluate(source))
}

Vitest.describe("Minify.whitespace", () => {
  Vitest.it("removes indentation, blank lines, and spaces between tokens that can't run together", () => {
    expectMinified(
      "const total = (items) => {\n\n    let sum = 0\n    for (const item of items) {\n      sum += item\n    }\n    return sum\n  }\n  total([1, 2, 3])",
      "const total=(items)=>{let sum=0\nfor(const item of items){sum+=item}\nreturn sum}\ntotal([1,2,3])"
    )
  })

  Vitest.it("keeps a line break where it ends a statement, so the module reads the same", () => {
    // A line break ends the return statement: undefined, not 1
    expectMinified("(function () {\n  return\n  1\n})()", "(function(){return\n1})()")
    // Even before a parenthesis, which would otherwise continue the statement
    expectMinified("(function () {\n  return\n  (1)\n})()", "(function(){return\n(1)})()")
    // A line break before ++ makes it the next statement's prefix
    expectMinified("let a = 1\nlet b = 1\na\n++b\n;[a, b]", "let a=1\nlet b=1\na\n++b;[a,b]")
    // No semicolon is inserted before a parenthesis; the line break doesn't change that
    expectMinified("const f = (x) => x + 1\nconst y = f\n(2)\ny", "const f=(x)=>x+1\nconst y=f(2)\ny")
    // After a ++ that follows a value, the next line is a new statement
    expectMinified("let a = 1\nlet b = [1]\na++\n;[a, b]", "let a=1\nlet b=[1]\na++\n;[a,b]")
  })

  Vitest.it("drops line breaks that change nothing, such as before an operator, a dot, or a closing bracket", () => {
    expectMinified(
      "const values = [\n  1,\n  2\n]\nconst sum =\n  values[0]\n  + values[1]\nconst text = 'a'\n  .repeat(2)\n;[sum, text]",
      "const values=[1,2]\nconst sum=values[0]+values[1]\nconst text='a'.repeat(2);[sum,text]"
    )
  })

  Vitest.it("keeps a space where tokens would otherwise read differently", () => {
    expectMinified("const a = 1\nconst b = 2\na + +b", "const a=1\nconst b=2\na+ +b")
    expectMinified("const a = 3\nconst b = 1\na - -b", "const a=3\nconst b=1\na- -b")
    expectMinified("1 .toString()", "1 .toString()")
    expectMinified("const x = { g: 1 }\n'g' in x && typeof x", "const x={g:1}\n'g'in x&&typeof x")
    expectMinified("const a = 4\na / /2/.source.length", "const a=4\na/ /2/.source.length")
    Vitest.expect(Minify.whitespace("const r = /a/g in x")).toBe("const r=/a/g in x")
  })

  Vitest.it("leaves strings, templates, and regular expressions as they are", () => {
    expectMinified("const name = 'a  b';\n`x  ${ name }  y`", "const name='a  b';`x  ${name}  y`")
    expectMinified("/a  b/.test('a  b')", "/a  b/.test('a  b')")
  })
})
