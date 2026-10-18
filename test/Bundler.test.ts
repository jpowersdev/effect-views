import * as Effect from "effect/Effect"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import * as Vitest from "vitest"

import * as Bundler from "../src/internal/Bundler.js"

const repository = Path.resolve(import.meta.dirname, "..")

const directories: Array<string> = []

Vitest.afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Writes files, by their paths relative to a new directory, and returns the directory. */
const fixture = async (files: Readonly<Record<string, string>>, parent = tmpdir()): Promise<string> => {
  await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(Path.join(parent, "effect-views-bundler-")))
  directories.push(root)
  await write(root, files)
  return root
}

const write = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, content] of Object.entries(files)) {
    const path = Path.join(root, name)
    await mkdir(Path.dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

const bundle = (root: string, entries: ReadonlyArray<string>, prefix: `/${string}` = "/assets") =>
  Effect.runPromise(Bundler.bundle({ root, prefix, entries: entries.map((entry) => Path.join(root, entry)) }))

const failure = (root: string, entries: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.flip(Bundler.bundle({ root, prefix: "/assets", entries: entries.map((entry) => Path.join(root, entry)) }))
  )

const decoder = new TextDecoder()

/** Each file's text by its URL path. */
const texts = (result: Bundler.Bundle): ReadonlyMap<string, string> =>
  new Map(result.files.map((file) => [file.path, decoder.decode(file.body)]))

/** The text of an entry, by its path relative to the root. */
const entryText = (root: string, result: Bundler.Bundle, entry: string): string =>
  texts(result).get(result.entries.get(Path.join(root, entry))!)!

/** The URL paths a file imports, in order. */
const importsOf = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/(?:from |import\(|import )(["'`])(\/assets\/[^"'`]+)\1/g)].map((match) => match[2]!)

/**
 * Bundles with a directory as the prefix, writes the files there, and imports
 * the first entry in a new Node process, outside Vitest's module runner, which
 * resolves the rewritten imports as file paths. The directory is outside the
 * repository, so that an import left as it was can't resolve. Returns the
 * entry's exports.
 */
const run = async (root: string, entries: ReadonlyArray<string>, options?: { readonly root?: string }) => {
  const out = await fixture({})
  const result = await Effect.runPromise(Bundler.bundle({
    root: options?.root ?? root,
    prefix: `${out}/assets` as `/${string}`,
    entries: entries.map((entry) => Path.join(root, entry))
  }))
  for (const file of result.files) {
    await mkdir(Path.dirname(file.path), { recursive: true })
    await writeFile(file.path, file.body)
  }
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "--eval",
    "const module = await import(process.argv[1]); console.log(JSON.stringify(module))",
    pathToFileURL(result.entries.get(Path.join(root, entries[0]!))!).href
  ])
  return { exports: JSON.parse(stdout) as unknown, result }
}

const urlOf = (result: Bundler.Bundle, base: string): string => {
  const matches = result.files.filter((file) => new RegExp(`/${base}-[0-9a-f]{12}\\.js$`).test(file.path))
  if (matches.length !== 1) throw new Error(`Expected one file named ${base}, found ${matches.length}`)
  return matches[0]!.path
}

Vitest.describe("Bundler", () => {
  Vitest.it("writes a file for each module, its imports rewritten to their URLs", async () => {
    const root = await fixture({
      "src/main.js": [
        `#!/usr/bin/env node`,
        `/**`,
        ` * The entry.`,
        ` */`,
        `import { greet } from "./greet.js" // greet`,
        `import * as Pkg from 'pkg'`,
        `export const message = greet(Pkg.name) /* inline */ + "// kept"`
      ].join("\n"),
      "src/greet.js": `export const greet = (name) => \`Hello, \${name}\``,
      "node_modules/pkg/package.json": json({ name: "pkg", main: "./lib/index.js" }),
      "node_modules/pkg/lib/index.js": `export const name = "pkg"`
    })
    const result = await bundle(root, ["src/main.js"])

    Vitest.expect(result.files.map((file) => file.path)).toEqual(
      [urlOf(result, "greet"), urlOf(result, "index"), urlOf(result, "main")].sort()
    )
    for (const file of result.files) {
      Vitest.expect(file.path).toMatch(/^\/assets\/[A-Za-z0-9_-]+-[0-9a-f]{12}\.js$/)
      Vitest.expect(file.contentType).toBe("text/javascript; charset=utf-8")
    }
    Vitest.expect(result.entries).toEqual(new Map([[Path.join(root, "src/main.js"), urlOf(result, "main")]]))
    Vitest.expect(entryText(root, result, "src/main.js")).toBe([
      ``,
      `\n\n`,
      `import { greet } from "${urlOf(result, "greet")}" `,
      `import * as Pkg from '${urlOf(result, "index")}'`,
      `export const message = greet(Pkg.name)   + "// kept"`
    ].join("\n"))
    Vitest.expect(result.preloads).toEqual(
      new Map([[Path.join(root, "src/main.js"), [urlOf(result, "greet"), urlOf(result, "index")]]])
    )
  })

  Vitest.it("keeps the lines of the source, so positions in errors still match", async () => {
    const source = [
      `/* one`,
      `   two */ const a = 1 /**/ // three`,
      `/*`,
      `*/`,
      `export const b = a`
    ].join("\r\n")
    const root = await fixture({ "main.js": source })
    const text = entryText(root, await bundle(root, ["main.js"]), "main.js")
    Vitest.expect(text).toBe(`\n const a = 1   \r\n\n\r\nexport const b = a`)
    Vitest.expect(text.split(/\r\n|\n/)).toHaveLength(source.split("\r\n").length)
  })

  Vitest.it("prefers the browser condition, and ignores types and unknown conditions", async () => {
    const root = await fixture({
      "main.js": [`import "conditions"`, `import "conditions/feature"`, `import "ordered"`, `import "nested"`].join("\n"),
      "node_modules/conditions/package.json": json({
        name: "conditions",
        exports: {
          ".": {
            types: "./index.d.ts",
            "conditions-source": "./src/index.ts",
            node: "./node.js",
            browser: "./browser.js",
            default: "./default.js"
          },
          "./feature": { require: "./feature.cjs", unknown: "./unknown.js", import: "./feature.js" }
        }
      }),
      "node_modules/conditions/browser.js": "",
      "node_modules/conditions/default.js": "",
      "node_modules/conditions/node.js": "",
      "node_modules/conditions/feature.js": "",
      // The first key that matches wins, as in Node
      "node_modules/ordered/package.json": json({
        name: "ordered",
        exports: { default: "./default.js", browser: "./browser.js" }
      }),
      "node_modules/ordered/default.js": "",
      "node_modules/ordered/browser.js": "",
      "node_modules/nested/package.json": json({
        name: "nested",
        exports: { node: "./node.js", import: { types: "./x.d.ts", browser: "./nested.js" }, default: "./default.js" }
      }),
      "node_modules/nested/nested.js": "",
      "node_modules/nested/default.js": ""
    })
    const result = await bundle(root, ["main.js"])
    const sources = result.files.map((file) => file.path.replace(/-[0-9a-f]{12}\.js$/, "")).sort()
    Vitest.expect(sources).toEqual(["/assets/browser", "/assets/default", "/assets/feature", "/assets/main", "/assets/nested"])
    Vitest.expect(importsOf(entryText(root, result, "main.js"))).toEqual([
      urlOf(result, "browser"),
      urlOf(result, "feature"),
      urlOf(result, "default"),
      urlOf(result, "nested")
    ])
  })

  Vitest.it("maps subpath patterns, preferring the longest, and refuses null targets", async () => {
    const files = {
      "node_modules/patterns/package.json": json({
        name: "patterns",
        exports: {
          ".": "./dist/index.js",
          "./*": "./dist/*.js",
          "./internal/*": null,
          "./styles/*.js": { browser: "./dist/styles/*.browser.js" },
          "./package.json": "./package.json"
        }
      }),
      "node_modules/patterns/dist/index.js": "",
      "node_modules/patterns/dist/Thing.js": "",
      "node_modules/patterns/dist/deep/Other.js": "",
      "node_modules/patterns/dist/styles/button.browser.js": "",
      "node_modules/patterns/dist/internal/secret.js": ""
    }
    const root = await fixture({
      ...files,
      "main.js": [
        `import "patterns"`,
        `import "patterns/Thing"`,
        `import "patterns/deep/Other"`,
        `import "patterns/styles/button.js"`
      ].join("\n"),
      "secret.js": `import "./main.js"\nimport "patterns/internal/secret"`
    })
    const result = await bundle(root, ["main.js"])
    Vitest.expect(importsOf(entryText(root, result, "main.js"))).toEqual([
      urlOf(result, "index"),
      urlOf(result, "Thing"),
      urlOf(result, "Other"),
      urlOf(result, "button_browser")
    ])

    const error = await failure(root, ["secret.js"])
    Vitest.expect(error).toBeInstanceOf(Bundler.BundlerError)
    Vitest.expect(error.message).toBe(
      "Can't resolve patterns/internal/secret (patterns doesn't export ./internal/secret): " +
        "secret.js → patterns/internal/secret"
    )
  })

  Vitest.it("resolves the package's own imports field", async () => {
    const root = await fixture({
      "package.json": json({
        name: "app",
        imports: {
          "#util": "./src/util.js",
          "#lib/*": { browser: "./src/lib/*.browser.js", default: "./src/lib/*.js" },
          "#dep": "dep/feature"
        }
      }),
      "src/main.js": [`import "#util"`, `import "#lib/format"`, `import "#dep"`].join("\n"),
      "src/util.js": "",
      "src/lib/format.js": "",
      "src/lib/format.browser.js": "",
      "node_modules/dep/package.json": json({ name: "dep", exports: { "./feature": "./feature.js" } }),
      "node_modules/dep/feature.js": ""
    })
    const result = await bundle(root, ["src/main.js"])
    Vitest.expect(importsOf(entryText(root, result, "src/main.js"))).toEqual([
      urlOf(result, "util"),
      urlOf(result, "format_browser"),
      urlOf(result, "feature")
    ])
  })

  Vitest.it("resolves a package importing itself by name, ignoring its source condition", async () => {
    const root = await fixture({
      "package.json": json({
        name: "my-lib",
        exports: {
          ".": { "my-lib-source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./Thing": { "my-lib-source": "./src/Thing.ts", types: "./dist/Thing.d.ts", default: "./dist/Thing.js" }
        }
      }),
      "dist/index.js": `export * from "./Thing.js"`,
      "dist/Thing.js": `export const thing = 1`,
      "examples/main.js": `import { thing } from "my-lib/Thing"\nimport * as Lib from "my-lib"`
    })
    const result = await bundle(root, ["examples/main.js"])
    Vitest.expect(importsOf(entryText(root, result, "examples/main.js"))).toEqual([
      urlOf(result, "Thing"),
      urlOf(result, "index")
    ])
  })

  Vitest.it("reads each module once through pnpm's symlinks", async () => {
    const root = await fixture({
      "main.js": `import "a"\nimport "b"`,
      "node_modules/.pnpm/a@1/node_modules/a/index.js": `import "shared"`,
      "node_modules/.pnpm/b@1/node_modules/b/index.js": `import "shared"`,
      "node_modules/.pnpm/shared@1/node_modules/shared/index.js": `export const shared = 1`
    })
    await symlink(Path.join(root, "node_modules/.pnpm/a@1/node_modules/a"), Path.join(root, "node_modules/a"))
    await symlink(Path.join(root, "node_modules/.pnpm/b@1/node_modules/b"), Path.join(root, "node_modules/b"))
    for (const name of ["a", "b"]) {
      await symlink(
        Path.join(root, "node_modules/.pnpm/shared@1/node_modules/shared"),
        Path.join(root, `node_modules/.pnpm/${name}@1/node_modules/shared`)
      )
    }
    const result = await bundle(root, ["main.js"])
    Vitest.expect(result.files).toHaveLength(4)
    const [a, b, shared] = importsOf(entryText(root, result, "main.js")).map((url) => texts(result).get(url)!)
    Vitest.expect(importsOf(a!)).toEqual(importsOf(b!))
    Vitest.expect(shared).toBeUndefined()
  })

  Vitest.it("strips TypeScript's types, and finds ./x.ts for ./x.js", async () => {
    const root = await fixture({
      "src/main.ts": [
        `import { greet } from "./greet.js"`,
        `import type { Name } from "./types.js"`,
        `const name: Name = "Ada" as Name`,
        `export const message: string = greet(name)`
      ].join("\n"),
      "src/greet.ts": `export const greet = <A extends string>(name: A): string => \`Hello, \${name}\``,
      "src/types.ts": `export type Name = string`
    })
    const result = await bundle(root, ["src/main.ts"])
    Vitest.expect(result.files).toHaveLength(2)
    const main = entryText(root, result, "src/main.ts")
    // Types become as many spaces
    Vitest.expect(main).toBe([
      `import { greet } from "${urlOf(result, "greet")}"`,
      " ".repeat(`import type { Name } from "./types.js"`.length),
      `const name${" ".repeat(7)}= "Ada"${" ".repeat(8)}`,
      `export const message${" ".repeat(9)}= greet(name)`
    ].join("\n"))

    Vitest.expect((await run(root, ["src/main.ts"])).exports).toEqual({ message: "Hello, Ada" })
  })

  Vitest.it("bundles import cycles", async () => {
    const root = await fixture({
      "a.js": `import { b } from "./b.js"\nexport const a = () => b`,
      "b.js": `import { a } from "./a.js"\nexport const b = () => a`
    })
    const result = await bundle(root, ["a.js"])
    const a = urlOf(result, "a")
    const b = urlOf(result, "b")
    Vitest.expect(importsOf(texts(result).get(a)!)).toEqual([b])
    Vitest.expect(importsOf(texts(result).get(b)!)).toEqual([a])
    Vitest.expect(a.slice(-15)).not.toBe(b.slice(-15))
    Vitest.expect(result.preloads.get(Path.join(root, "a.js"))).toEqual([b])
  })

  Vitest.it("rewrites import() of a literal, leaves other import() alone, and preloads only static imports", async () => {
    const root = await fixture({
      "main.js": [
        `import "./static.js"`,
        `export const lazy = () => import("./lazy.js")`,
        "export const named = (name) => import(name)",
        "export const built = (name) => import(`./${name}.js`)"
      ].join("\n"),
      "static.js": `import "./deep.js"`,
      "deep.js": "",
      "lazy.js": `import "./deep.js"`
    })
    const result = await bundle(root, ["main.js"])
    Vitest.expect(entryText(root, result, "main.js")).toBe([
      `import "${urlOf(result, "static")}"`,
      `export const lazy = () => import("${urlOf(result, "lazy")}")`,
      "export const named = (name) => import(name)",
      "export const built = (name) => import(`./${name}.js`)"
    ].join("\n"))
    Vitest.expect(result.preloads.get(Path.join(root, "main.js"))).toEqual([urlOf(result, "deep"), urlOf(result, "static")])
  })

  Vitest.it("refuses Node's built-in modules, naming the chain of imports", async () => {
    const root = await fixture({
      "src/a.js": `import "./b.js"`,
      "src/b.js": `import { createHash } from "node:crypto"`,
      "src/c.js": `import * as Fs from "fs"`
    })
    Vitest.expect((await failure(root, ["src/a.js"])).message).toBe(
      "Can't bundle node:crypto for the browser: src/a.js → src/b.js → node:crypto"
    )
    Vitest.expect((await failure(root, ["src/c.js"])).message).toBe(
      "Can't bundle fs for the browser: src/c.js → fs"
    )
  })

  Vitest.it("refuses what it can't bundle", async () => {
    const root = await fixture({
      "main.js": `import "./View.tsx"`,
      "View.tsx": `export const view = <div />`,
      "common.js": `import "./legacy.cjs"`,
      "legacy.cjs": `module.exports = 1`,
      "data.js": `import data from "./data.json" with { type: "json" }`,
      "data.json": `{}`,
      "missing.js": `import "./nowhere.js"`,
      "unknown.js": `import "unknown-package"`,
      "broken.js": `export const s = "abc\n`
    })
    Vitest.expect((await failure(root, ["main.js"])).message).toBe(
      "Can't bundle View.tsx: JSX can't be bundled; run the server from compiled JavaScript, such as tsc's output: " +
        "main.js → View.tsx"
    )
    Vitest.expect((await failure(root, ["View.tsx"])).message).toMatch(/^Can't bundle View\.tsx: .*tsc's output$/)
    Vitest.expect((await failure(root, ["common.js"])).message).toBe(
      "Can't bundle legacy.cjs: only ES modules can be bundled, not CommonJS: common.js → legacy.cjs"
    )
    Vitest.expect((await failure(root, ["data.js"])).message).toBe(
      "data.js:1:18: Import attributes can't be bundled: ./data.json"
    )
    Vitest.expect((await failure(root, ["missing.js"])).message).toBe(
      "Can't resolve ./nowhere.js (there's no nowhere.js): missing.js → ./nowhere.js"
    )
    Vitest.expect((await failure(root, ["unknown.js"])).message).toBe(
      "Can't resolve unknown-package (there's no unknown-package in node_modules): unknown.js → unknown-package"
    )
    Vitest.expect((await failure(root, ["broken.js"])).message).toBe("broken.js:1:18: Unterminated string literal")

    const outside = `${root}-outside.js`
    directories.push(outside)
    await write(root, { "outside.js": `import "../${Path.basename(outside)}"` })
    await writeFile(outside, "")
    Vitest.expect((await failure(root, ["outside.js"])).message).toBe(
      `Can't bundle ${outside}: it's outside the root directory ${root}; set the root option to include it: ` +
        `outside.js → ../${Path.basename(outside)}`
    )
  })

  Vitest.it("gives the same files for the same sources, and new names below a change", async () => {
    const root = await fixture({
      "main.js": `import "./middle.js"\nimport "./other.js"`,
      "middle.js": `import "./deep.js"`,
      "deep.js": `export const deep = 1`,
      "other.js": `export const other = 1`
    })
    const first = await bundle(root, ["main.js"])
    const again = await bundle(root, ["main.js"])
    Vitest.expect(again.files.map((file) => [file.path, decoder.decode(file.body)]))
      .toEqual(first.files.map((file) => [file.path, decoder.decode(file.body)]))
    Vitest.expect(again.entries).toEqual(first.entries)
    Vitest.expect(again.preloads).toEqual(first.preloads)

    // A comment changes nothing served
    await write(root, { "deep.js": `export const deep = 1// the same` })
    Vitest.expect((await bundle(root, ["main.js"])).files.map((file) => file.path)).toEqual(
      first.files.map((file) => file.path)
    )

    await write(root, { "deep.js": `export const deep = 2` })
    const changed = await bundle(root, ["main.js"])
    for (const name of ["main", "middle", "deep"]) Vitest.expect(urlOf(changed, name)).not.toBe(urlOf(first, name))
    Vitest.expect(urlOf(changed, "other")).toBe(urlOf(first, "other"))
  })

  Vitest.it("bundles Effect, so that Node runs the result", { timeout: 60_000 }, async () => {
    // In the repository, so that effect resolves from its node_modules
    const root = await fixture({
      "main.js": [
        `import * as Effect from "effect/Effect"`,
        `import * as Schema from "effect/Schema"`,
        `import * as Stream from "effect/Stream"`,
        ``,
        `export const result = Effect.runSync(Effect.succeed(21).pipe(Effect.map((n) => n * 2)))`,
        `const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })`,
        `export const person = Schema.decodeUnknownSync(Person)({ name: "Ada", age: 36 })`,
        `export const invalid = Schema.decodeUnknownExit(Person)({ name: 1 })._tag`,
        `export const streamed = Effect.runSync(Stream.runCollect(Stream.make(1, 2, 3).pipe(Stream.map((n) => n * 10))))`
      ].join("\n")
    }, Path.join(repository, "node_modules", ".cache"))

    const { exports, result } = await run(root, ["main.js"], { root: repository })
    Vitest.expect(exports).toEqual({
      result: 42,
      person: { name: "Ada", age: 36 },
      invalid: "Failure",
      streamed: [10, 20, 30]
    })
    Vitest.expect(result.files.length).toBeGreaterThan(100)
    Vitest.expect(result.preloads.get(Path.join(root, "main.js"))!.length).toBeGreaterThan(100)
  })
})
