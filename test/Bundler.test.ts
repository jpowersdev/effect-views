import * as Effect from "effect/Effect"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import * as Vitest from "vitest"

import * as Bundler from "../src/internal/Bundler.js"
import * as Shake from "../src/internal/Shake.js"
import * as Tokenizer from "../src/internal/Tokenizer.js"

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

/** Bundles without minifying, so tests can read the files as the bundler rewrote and shook them. */
const bundle = (root: string, entries: ReadonlyArray<string>, prefix: `/${string}` = "/assets") =>
  Effect.runPromise(
    Bundler.bundle({ root, prefix, minify: false, entries: entries.map((entry) => Path.join(root, entry)) })
  )

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
const run = async (
  root: string,
  entries: ReadonlyArray<string>,
  options?: { readonly root?: string; readonly shake?: boolean }
) => {
  const out = await fixture({})
  const result = await Effect.runPromise(Bundler.bundle({
    root: options?.root ?? root,
    prefix: `${out}/assets` as `/${string}`,
    entries: entries.map((entry) => Path.join(root, entry)),
    ...(options?.shake === undefined ? {} : { shake: options.shake })
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

/**
 * What wouldn't link in the browser: imports of files the bundle doesn't
 * have, and names imported that the file imported doesn't export.
 */
const unlinked = (result: Bundler.Bundle): ReadonlyArray<string> => {
  const modules = new Map(result.files.map((file) => {
    const source = decoder.decode(file.body)
    const scan = Tokenizer.scan(source)
    return [file.path, { scan, analysis: Shake.analyze(source, scan) }] as const
  }))
  const provides = (path: string, name: string, seen: Set<string>): boolean => {
    const module = modules.get(path)
    if (module === undefined || seen.has(path)) return false
    seen.add(path)
    const { analysis, scan } = module
    if (analysis.exports.has(name) || analysis.reexports.has(name)) return true
    return name !== "default" && analysis.stars.some((star) => provides(scan.imports[star]!.specifier, name, seen))
  }
  const problems: Array<string> = []
  for (const [path, { analysis, scan }] of modules) {
    for (const entry of scan.imports) {
      if (!modules.has(entry.specifier)) problems.push(`${path} imports ${entry.specifier}, which isn't bundled`)
    }
    const imported = [...analysis.bindings.values(), ...analysis.reexports.values()]
    for (const { imported: name, source } of imported) {
      const target = scan.imports[source]!.specifier
      if (name !== "*" && modules.has(target) && !provides(target, name, new Set())) {
        problems.push(`${path} imports ${name} from ${target}, which doesn't export it`)
      }
    }
  }
  return problems
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
      "src/b.js": `import { createHash } from "node:crypto"\ncreateHash("sha256")`,
      "src/c.js": `import * as Fs from "fs"\nexport const read = Fs.readFile`,
      // Unused, an import that can't be bundled is dropped
      "src/d.js": `import { createHash } from "node:crypto"\nexport const d = 1`
    })
    Vitest.expect((await failure(root, ["src/a.js"])).message).toBe(
      "Can't bundle node:crypto for the browser: src/a.js → src/b.js → node:crypto"
    )
    Vitest.expect((await failure(root, ["src/c.js"])).message).toBe(
      "Can't bundle fs for the browser: src/c.js → fs"
    )
    Vitest.expect(entryText(root, await bundle(root, ["src/d.js"]), "src/d.js")).toBe(";\nexport const d = 1")
  })

  Vitest.it("refuses what it can't bundle", async () => {
    const root = await fixture({
      "main.js": `import "./View.tsx"`,
      "View.tsx": `export const view = <p>Fish &amp; chips &bogus;</p>`,
      "common.js": `import "./legacy.cjs"`,
      "legacy.cjs": `module.exports = 1`,
      "data.js": `import data from "./data.json" with { type: "json" }`,
      "plain.js": `import "./data.json"`,
      "data.json": `{}`,
      "missing.js": `import "./nowhere.js"`,
      "unknown.js": `import "unknown-package"`,
      "broken.js": `export const s = "abc\n`
    })
    Vitest.expect((await failure(root, ["main.js"])).message).toBe(
      "View.tsx:1:41: Unknown HTML entity &bogus;: main.js → View.tsx"
    )
    Vitest.expect((await failure(root, ["common.js"])).message).toBe(
      "Can't bundle legacy.cjs: only ES modules can be bundled, not CommonJS: common.js → legacy.cjs"
    )
    Vitest.expect((await failure(root, ["data.js"])).message).toBe(
      "data.js:1:18: Import attributes can't be bundled: ./data.json"
    )
    Vitest.expect((await failure(root, ["plain.js"])).message).toBe(
      "Can't bundle data.json: only JavaScript, TypeScript and JSX modules can be bundled: plain.js → data.json"
    )
    Vitest.expect((await failure(root, ["missing.js"])).message).toBe(
      "Can't resolve ./nowhere.js (there's no nowhere.js): missing.js → ./nowhere.js"
    )
    Vitest.expect((await failure(root, ["unknown.js"])).message).toBe(
      "Can't resolve unknown-package (there's no unknown-package in node_modules): unknown.js → unknown-package"
    )
    Vitest.expect((await failure(root, ["broken.js"])).message).toBe("broken.js:1:18: Unterminated string literal")

  })

  Vitest.it("bundles modules outside the root, such as a workspace's node_modules above the application", async () => {
    const root = await fixture({})
    const outside = `${root}-outside.js`
    directories.push(outside)
    await write(root, { "main.js": `export { value } from "../${Path.basename(outside)}"` })
    await writeFile(outside, `export const value = 42`)
    const result = await bundle(root, ["main.js"])
    Vitest.expect(result.files.map((file) => file.path.replace(/-[0-9a-f]{12}\.js$/, ""))).toContain(
      `/assets/${Path.basename(outside).replace(/\.js$/, "").replace(/[^A-Za-z0-9_-]/g, "_")}`
    )
  })

  Vitest.it("gives the same files for the same sources, and new names below a change", async () => {
    const root = await fixture({
      "main.js": `import { deep } from "./middle.js"\nimport "./other.js"\nexport const value = deep`,
      "middle.js": `export { deep } from "./deep.js"`,
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

    // Code nothing uses becomes a semicolon, so changing it changes nothing served
    await write(root, { "deep.js": `export const deep = 2\nexport const unused = () => 3` })
    const unused = await bundle(root, ["main.js"])
    await write(root, { "deep.js": `export const deep = 2\nexport const unused = () => 4` })
    Vitest.expect((await bundle(root, ["main.js"])).files.map((file) => file.path)).toEqual(
      unused.files.map((file) => file.path)
    )
  })

  Vitest.describe("tree-shaking", () => {
    /** A package whose modules do nothing when imported, but for those in sideEffects. */
    const pure = (files: Readonly<Record<string, string>>, sideEffects: boolean | ReadonlyArray<string> = false) =>
      fixture({ "package.json": json({ name: "app", type: "module", sideEffects }), ...files })

    const textOf = (result: Bundler.Bundle, base: string) => texts(result).get(urlOf(result, base))!

    Vitest.it("keeps what the entries use, trims export lists, and drops what nothing needs", async () => {
      const root = await pure({
        "main.js": `import { a, renamed } from "./lib.js"\nexport const value = a + renamed`,
        "lib.js": [
          `import { helper, unusedHelper } from "./helpers.js"`,
          `const a = helper(1)`,
          `const b = 2`,
          `function unused() { return unusedHelper() }`,
          `export { a, b as renamed, unused }`,
          `export const alsoUnused = () => b`
        ].join("\n"),
        "helpers.js": `export const helper = (x) => x * 10\nexport const unusedHelper = () => 0`,
        "nothing.js": `export const nothing = 1`
      })
      const result = await bundle(root, ["main.js"])
      Vitest.expect(result.files).toHaveLength(3)
      Vitest.expect(textOf(result, "lib")).toBe([
        `import { helper } from "${urlOf(result, "helpers")}";`,
        `const a = helper(1)`,
        `const b = 2`,
        `;`,
        `export { a, b as renamed };`,
        `;`
      ].join("\n"))
      Vitest.expect(textOf(result, "helpers")).toBe(`export const helper = (x) => x * 10\n;`)
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: 12 })
    })

    Vitest.it("follows export * through chains, to the module that defines a name", async () => {
      const root = await pure({
        "main.js": `import { deep, middle } from "./barrel.js"\nexport const value = [deep, middle]`,
        "barrel.js": `export * from "./middle.js"\nexport * from "./other.js"`,
        "middle.js": `export * from "./deep.js"\nexport const middle = "middle"\nexport const unused = 1`,
        "deep.js": `export const deep = "deep"\nexport const alsoUnused = 2`,
        "other.js": `export const other = 3`
      })
      const result = await bundle(root, ["main.js"])
      Vitest.expect(result.files.map((file) => file.path.replace(/-[0-9a-f]{12}\.js$/, "")).sort())
        .toEqual(["/assets/barrel", "/assets/deep", "/assets/main", "/assets/middle"])
      Vitest.expect(textOf(result, "barrel")).toBe(`export * from "${urlOf(result, "middle")}"\n;`)
      Vitest.expect(textOf(result, "deep")).toBe(`export const deep = "deep"\n;`)
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: ["deep", "middle"] })
    })

    Vitest.it("keeps only the members read from a namespace, unless it escapes", async () => {
      const root = await pure({
        "main.js": [
          `import * as Read from "./read.js"`,
          `import * as Escapes from "./escapes.js"`,
          `export const value = [Read.a, Read?.["b"]]`,
          `export const keys = Object.keys(Escapes)`
        ].join("\n"),
        "read.js": `export const a = 1\nexport const b = 2\nexport const c = 3`,
        "escapes.js": `export const x = 1\nexport const y = 2`
      })
      const result = await bundle(root, ["main.js"])
      Vitest.expect(textOf(result, "read")).toBe(`export const a = 1\nexport const b = 2\n;`)
      Vitest.expect(textOf(result, "escapes")).toBe(`export const x = 1\nexport const y = 2`)
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: [1, 2], keys: ["x", "y"] })
    })

    Vitest.it("keeps modules with side effects that are imported, even for nothing", async () => {
      const root = await pure({
        "main.js": [
          `import "./polyfill.js"`,
          `import "./quiet.js"`,
          `import { unused } from "./effectful.js"`,
          `import { alsoUnused } from "./quiet.js"`,
          `export const ran = globalThis.ran`
        ].join("\n"),
        "polyfill.js": `globalThis.ran = ["polyfill"]`,
        "effectful.js": `globalThis.ran.push("effectful")\nexport const unused = 1`,
        "quiet.js": `export const alsoUnused = 1`
      }, ["./polyfill.js", "effectful.js"])
      const result = await bundle(root, ["main.js"])
      Vitest.expect(entryText(root, result, "main.js")).toBe([
        `import "${urlOf(result, "polyfill")}"`,
        `;`,
        `import "${urlOf(result, "effectful")}";`,
        `;`,
        `export const ran = globalThis.ran`
      ].join("\n"))
      Vitest.expect(textOf(result, "effectful")).toBe(`globalThis.ran.push("effectful")\n;`)
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ ran: ["polyfill", "effectful"] })
    })

    Vitest.it("drops pure calls nothing uses, also inside arrows, and keeps the rest of an included module", async () => {
      const root = await pure({
        "main.js": `import { used } from "./lib.js"\nexport const value = used()`,
        "lib.js": [
          `const make = (x) => /*#__PURE__*/ create(x)`,
          `const created = /*#__PURE__*/ create(1)`,
          `const constructed = /* @__PURE__ */ new Map()`,
          `export const used = () => "used"`,
          `globalThis.libRan = true`,
          `function create(x) { return x }`
        ].join("\n")
      })
      const result = await bundle(root, ["main.js"])
      Vitest.expect(textOf(result, "lib")).toBe([`;`, `;`, `;`, `export const used = () => "used"`, `globalThis.libRan = true`, `;`].join("\n"))
    })

    Vitest.it("drops classes that do nothing when defined, and keeps those that do", async () => {
      const root = await pure({
        "main.js": `import { used } from "./classes.js"\nexport const value = [used.name, globalThis.defined]`,
        "classes.js": [
          `class Base {}`,
          `export class Unused extends Base { static count = 0; method() { sideEffect() } }`,
          `export class Defines { static { globalThis.defined = "defined" } }`,
          `export class Calls extends mixin(Base) {}`,
          `function mixin(base) { return class extends base {} }`,
          `export { Base as used }`
        ].join("\n")
      })
      const result = await bundle(root, ["main.js"])
      Vitest.expect(textOf(result, "classes")).toBe([
        `class Base {}`,
        `;`,
        `export class Defines { static { globalThis.defined = "defined" } }`,
        `export class Calls extends mixin(Base) {}`,
        `function mixin(base) { return class extends base {} }`,
        `export { Base as used }`
      ].join("\n"))
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: ["Base", "defined"] })
    })

    Vitest.it("shakes import cycles", async () => {
      const root = await pure({
        "main.js": `import { a } from "./a.js"\nexport const value = a()`,
        "a.js": `import { b } from "./b.js"\nexport const a = () => "a" + b()\nexport const unusedA = 1`,
        "b.js": `import { a, unusedA } from "./a.js"\nexport const b = () => "b"\nexport const loop = () => a() + unusedA`
      })
      const result = await bundle(root, ["main.js"])
      Vitest.expect(textOf(result, "b")).toBe(`;\nexport const b = () => "b"\n;`)
      Vitest.expect(importsOf(textOf(result, "a"))).toEqual([urlOf(result, "b")])
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: "ab" })
    })

    Vitest.it("keeps statements apart where a dropped one separated them", async () => {
      const root = await pure({
        "main.js": `import { run } from "./lib.js"\nexport const value = run`,
        "lib.js": [`export let run = ["first"]`, `function unused() {}`, `(run = [...run, "second"])`].join("\n")
      })
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: ["first", "second"] })
    })

    Vitest.it("refuses an import that can't be bundled only if what holds it is kept", async () => {
      const root = await pure({
        "main.js": `import { browser } from "./lib.js"\nexport const value = browser`,
        "server.js": `import { browser } from "./lib.js"\nexport const value = browser`,
        "lib.js": [
          `import { createHash } from "node:crypto"`,
          `import { unknown } from "./missing.js"`,
          `export const browser = "browser"`,
          `export const server = () => [createHash, unknown]`
        ].join("\n")
      })
      Vitest.expect((await run(root, ["main.js"])).exports).toEqual({ value: "browser" })
      await write(root, { "server.js": `import { server } from "./lib.js"\nexport const value = server` })
      Vitest.expect((await failure(root, ["server.js"])).message).toBe(
        "Can't bundle node:crypto for the browser: server.js → lib.js → node:crypto"
      )
    })

    Vitest.it("serves every module whole with shake: false", async () => {
      const root = await pure({
        "main.js": `import { a } from "./lib.js"\nexport const value = a`,
        "lib.js": `export const a = 1\nexport const b = 2`
      })
      const result = await Effect.runPromise(
        Bundler.bundle({ root, prefix: "/assets", entries: [Path.join(root, "main.js")], shake: false, minify: false })
      )
      Vitest.expect(textOf(result, "lib")).toBe(`export const a = 1\nexport const b = 2`)
    })
  })

  Vitest.it("bundles the browser runtime and a live component both ways, linked", { timeout: 60_000 }, async () => {
    const entries = ["src/client/start.ts", "test/fixtures/Toggle.browser.ts"].map((entry) => Path.join(repository, entry))
    const [whole, shaken] = await Promise.all([false, true].map((shake) =>
      Effect.runPromise(Bundler.bundle({ root: repository, prefix: "/assets", entries, shake }))
    ))
    Vitest.expect(unlinked(whole!)).toEqual([])
    Vitest.expect(unlinked(shaken!)).toEqual([])
    Vitest.expect(shaken!.files.length).toBeLessThan(whole!.files.length)
    const bytes = (result: Bundler.Bundle) => result.files.reduce((sum, file) => sum + file.body.length, 0)
    Vitest.expect(bytes(shaken!)).toBeLessThan(bytes(whole!) / 2)
    for (const entry of entries) {
      for (const path of shaken!.preloads.get(entry)!) Vitest.expect(texts(shaken!).has(path)).toBe(true)
    }
  })

  Vitest.it("compiles JSX, with effect-views' runtime from the repository's sources", { timeout: 60_000 }, async () => {
    const root = await fixture({}, Path.join(repository, "node_modules", ".cache"))
    const sources = Path.relative(root, Path.join(repository, "src"))
    await write(root, {
      "View.tsx": [
        `/** @jsxImportSource ${sources} */`,
        `import * as Html from "${sources}/Html.js"`,
        ``,
        `const Card = (props: { readonly title: string; readonly children?: Html.Child }) => (`,
        `  <section class="card">`,
        `    <h2>{props.title}</h2>`,
        `    {props.children}`,
        `  </section>`,
        `)`,
        ``,
        `export const html = Html.render(`,
        `  <Card title="Fish &amp; chips">`,
        `    <p data-count={3} hidden>`,
        `      Three &mdash;`,
        `      items`,
        `    </p>`,
        `    <ul>{["a", "b"].map((item: string) => <li key={item}>{item}</li>)}</ul>`,
        `    <>{"<escaped>"}</>`,
        `  </Card>`,
        `)`
      ].join("\n")
    })
    const { exports, result } = await run(root, ["View.tsx"], { root: repository })
    Vitest.expect(exports).toEqual({
      html: `<section class="card"><h2>Fish &amp; chips</h2><p data-count="3" hidden>Three — items</p>` +
        `<ul><li data-key="a">a</li><li data-key="b">b</li></ul>&lt;escaped&gt;</section>`
    })
    Vitest.expect(result.files.map((file) => file.path)).toContainEqual(
      Vitest.expect.stringMatching(/\/jsx-runtime-[0-9a-f]{12}\.js$/)
    )
  })

  Vitest.describe("on Effect", () => {
    /** Writes a program in the repository, so that effect resolves, and runs it bundled. */
    const effect = async (program: ReadonlyArray<string>, options?: { readonly shake?: boolean }) => {
      const root = await fixture({ "main.js": program.join("\n") }, Path.join(repository, "node_modules", ".cache"))
      const ran = await run(root, ["main.js"], { root: repository, ...options })
      Vitest.expect(unlinked(ran.result)).toEqual([])
      return ran
    }

    const bytes = (result: Bundler.Bundle) => result.files.reduce((sum, file) => sum + file.body.length, 0)

    Vitest.it("bundles Effect, Schema and Stream, so that Node runs the result", { timeout: 60_000 }, async () => {
      const { exports, result } = await effect([
        `import * as Effect from "effect/Effect"`,
        `import * as Schema from "effect/Schema"`,
        `import * as Stream from "effect/Stream"`,
        ``,
        `export const result = Effect.runSync(Effect.succeed(21).pipe(Effect.map((n) => n * 2)))`,
        `const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })`,
        `export const person = Schema.decodeUnknownSync(Person)({ name: "Ada", age: 36 })`,
        `export const invalid = Schema.decodeUnknownExit(Person)({ name: 1 })._tag`,
        `export const streamed = Effect.runSync(Stream.runCollect(Stream.make(1, 2, 3).pipe(Stream.map((n) => n * 10))))`
      ])
      Vitest.expect(exports).toEqual({
        result: 42,
        person: { name: "Ada", age: 36 },
        invalid: "Failure",
        streamed: [10, 20, 30]
      })
      Vitest.expect(result.files.length).toBeGreaterThan(20)
    })

    Vitest.it("ships less of Effect shaken", { timeout: 60_000 }, async () => {
      const program = [`import * as Effect from "effect/Effect"`, `export const value = Effect.runSync(Effect.succeed(1))`]
      const shaken = await effect(program)
      const whole = await effect(program, { shake: false })
      Vitest.expect(shaken.exports).toEqual({ value: 1 })
      Vitest.expect(whole.exports).toEqual({ value: 1 })
      Vitest.expect(shaken.result.files.length).toBeLessThan(whole.result.files.length / 2)
      Vitest.expect(bytes(shaken.result)).toBeLessThan(bytes(whole.result) / 3)
    })

    Vitest.it("runs fibers in a FiberMap until their Scope closes", { timeout: 60_000 }, async () => {
      const { exports } = await effect([
        `import * as Effect from "effect/Effect"`,
        `import * as Exit from "effect/Exit"`,
        `import * as FiberMap from "effect/FiberMap"`,
        `import * as Scope from "effect/Scope"`,
        `import * as Stream from "effect/Stream"`,
        `export const result = await Effect.runPromise(Effect.gen(function* () {`,
        `  const scope = yield* Scope.make()`,
        `  const map = yield* FiberMap.make().pipe(Scope.provide(scope))`,
        `  yield* FiberMap.run(map, "a", Effect.never)`,
        `  yield* FiberMap.run(map, "b", Effect.never)`,
        `  const size = yield* FiberMap.size(map)`,
        `  yield* Scope.close(scope, Exit.void)`,
        `  const after = yield* FiberMap.size(map)`,
        `  const odd = yield* Stream.runCollect(Stream.range(1, 6).pipe(Stream.filter((n) => n % 2 === 1)))`,
        `  return { size, after, odd }`,
        `}))`
      ])
      Vitest.expect(exports).toEqual({ result: { size: 2, after: 0, odd: [1, 3, 5] } })
    })

    Vitest.it("decodes and encodes structs, unions of tagged structs and classes, and formats errors", { timeout: 60_000 }, async () => {
      const { exports } = await effect([
        `import * as Schema from "effect/Schema"`,
        `const Person = Schema.Struct({ name: Schema.String, age: Schema.NumberFromString })`,
        `const Shape = Schema.Union([`,
        `  Schema.TaggedStruct("Circle", { radius: Schema.Number }),`,
        `  Schema.TaggedStruct("Square", { side: Schema.Number })`,
        `])`,
        `class User extends Schema.Class("User")({ id: Schema.Number, name: Schema.String }) {`,
        `  get label() { return this.id + ": " + this.name }`,
        `}`,
        `export const decoded = Schema.decodeUnknownSync(Person)({ name: "Ada", age: "36" })`,
        `export const encoded = Schema.encodeSync(Person)(decoded)`,
        `export const shape = Schema.decodeUnknownSync(Shape)({ _tag: "Square", side: 2 })`,
        `const user = Schema.decodeUnknownSync(User)({ id: 1, name: "Ada" })`,
        `export const label = user instanceof User ? user.label : "not a User"`,
        `export const encodedUser = Schema.encodeSync(User)(user)`,
        `export let error`,
        `try { Schema.decodeUnknownSync(Shape)({ _tag: "Square", side: "2" }) } catch (cause) { error = cause.message }`
      ])
      Vitest.expect(exports).toEqual({
        decoded: { name: "Ada", age: 36 },
        encoded: { name: "Ada", age: "36" },
        shape: { _tag: "Square", side: 2 },
        label: "1: Ada",
        encodedUser: { id: 1, name: "Ada" },
        error: `Expected number\n  at ["side"]`
      })
    })

    Vitest.it("builds an HttpApi client", { timeout: 60_000 }, async () => {
      const { exports } = await effect([
        `import * as Effect from "effect/Effect"`,
        `import * as Schema from "effect/Schema"`,
        `import * as FetchHttpClient from "effect/http/FetchHttpClient"`,
        `import * as HttpApi from "effect/http-api/HttpApi"`,
        `import * as HttpApiClient from "effect/http-api/HttpApiClient"`,
        `import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"`,
        `import * as HttpApiGroup from "effect/http-api/HttpApiGroup"`,
        `const Api = HttpApi.make("api").add(`,
        `  HttpApiGroup.make("todos")`,
        `    .add(HttpApiEndpoint.get("list", "/todos", { success: Schema.Array(Schema.String) }))`,
        `    .add(HttpApiEndpoint.post("create", "/todos", { payload: Schema.Struct({ title: Schema.String }), success: Schema.String }))`,
        `)`,
        `const client = await Effect.runPromise(`,
        `  HttpApiClient.make(Api, { baseUrl: "http://localhost:1" }).pipe(Effect.provide(FetchHttpClient.layer))`,
        `)`,
        `export const result = [typeof client.todos.list, typeof client.todos.create]`
      ])
      Vitest.expect(exports).toEqual({ result: ["function", "function"] })
    })

    Vitest.it("provides a Context.Service with a Layer", { timeout: 60_000 }, async () => {
      const { exports } = await effect([
        `import * as Context from "effect/Context"`,
        `import * as Effect from "effect/Effect"`,
        `import * as Layer from "effect/Layer"`,
        `class Greeter extends Context.Service()("Greeter") {}`,
        `class Prefix extends Context.Service()("Prefix") {}`,
        `const GreeterLive = Layer.effect(Greeter)(Effect.gen(function* () {`,
        `  const prefix = yield* Prefix`,
        `  return { greet: (name) => prefix + ", " + name }`,
        `})).pipe(Layer.provide(Layer.succeed(Prefix)("Hello")))`,
        `export const result = Effect.runSync(Effect.gen(function* () {`,
        `  const greeter = yield* Greeter`,
        `  return greeter.greet("Ada")`,
        `}).pipe(Effect.provide(GreeterLive)))`
      ])
      Vitest.expect(exports).toEqual({ result: "Hello, Ada" })
    })
  })
})
