// Runs tests in a real browser: headless Chromium, driven through the Chrome
// DevTools Protocol with Node's own WebSocket, so no browser automation
// library is needed. Without Chromium the browser tests are skipped; set
// CHROMIUM to its path when it is not on the PATH.
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

const candidates = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]

/** Chromium or Chrome, from CHROMIUM or the PATH. */
export const executable: string | undefined = process.env["CHROMIUM"] ?? (() => {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    for (const name of candidates) {
      const path = join(directory, name)
      if (existsSync(path)) return path
    }
  }
  return undefined
})()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const poll = async <A>(read: () => A | undefined, timeoutMs: number, what: string): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(25)
  }
}

interface Message {
  readonly id?: number
  readonly method?: string
  readonly params?: any
  readonly result?: any
  readonly error?: { readonly message: string }
}

const keys = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 }
} as const

export interface Page {
  readonly goto: (url: string) => Promise<void>
  /** Resolves when the next page has loaded, such as one the page navigates to itself. */
  readonly loaded: () => Promise<void>
  /** Evaluates an expression in the page, awaiting a promise it returns. */
  readonly evaluate: <A = unknown>(expression: string) => Promise<A>
  /** Waits until an expression is truthy in the page. */
  readonly waitFor: (expression: string, timeoutMs?: number) => Promise<void>
  /** Types text into the focused element, one key press at a time. */
  readonly type: (text: string) => Promise<void>
  readonly press: (key: keyof typeof keys) => Promise<void>
  /** Console messages and uncaught errors, for assertions and debugging. */
  readonly messages: ReadonlyArray<string>
}

export interface Browser {
  readonly page: Page
  readonly close: () => Promise<void>
}

export const launch = async (): Promise<Browser> => {
  if (executable === undefined) throw new Error("No Chromium: set CHROMIUM")
  const profile = mkdtempSync(join(tmpdir(), "effect-views-chromium-"))
  const child: ChildProcess = spawn(executable, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1024,768",
    "about:blank"
  ], { stdio: "ignore" })

  // Chromium writes the port it chose to the profile
  const port = await poll(() => {
    try {
      return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] || undefined
    } catch {
      return undefined
    }
  }, 15_000, "Chromium to start")
  const targets: ReadonlyArray<{ readonly type: string; readonly webSocketDebuggerUrl: string }> =
    await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = targets.find((candidate) => candidate.type === "page")
  if (target === undefined) throw new Error("Chromium has no page")

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let nextId = 0
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Set<(message: Message) => void>()
  const messages: Array<string> = []
  socket.onmessage = (event) => {
    const message: Message = JSON.parse(String(event.data))
    const waiting = message.id === undefined ? undefined : pending.get(message.id)
    if (waiting !== undefined) {
      pending.delete(message.id!)
      if (message.error !== undefined) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
      return
    }
    if (message.method === "Runtime.consoleAPICalled") {
      messages.push(`${message.params.type}: ${message.params.args.map((arg: any) => arg.value ?? arg.description).join(" ")}`)
    } else if (message.method === "Runtime.exceptionThrown") {
      messages.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    }
    for (const listener of listeners) listener(message)
  }
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  await send("Runtime.enable")
  await send("Page.enable")

  const evaluate = async <A>(expression: string): Promise<A> => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (exceptionDetails !== undefined) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    }
    return result.value as A
  }

  const loaded = () =>
    new Promise<void>((resolve) => {
      const listener = (message: Message) => {
        if (message.method !== "Page.loadEventFired") return
        listeners.delete(listener)
        resolve()
      }
      listeners.add(listener)
    })

  const page: Page = {
    goto: async (url) => {
      const load = loaded()
      await send("Page.navigate", { url })
      await load
    },
    loaded,
    evaluate,
    waitFor: async (expression, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs
      while (!(await evaluate<boolean>(`Boolean(${expression})`))) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${expression}\n${messages.join("\n")}`)
        }
        await sleep(20)
      }
    },
    type: async (text) => {
      for (const character of text) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character })
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: character })
      }
    },
    press: async (key) => {
      const { code, keyCode, ...rest } = keys[key]
      const text = "text" in rest ? { text: rest.text } : {}
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...text })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode })
    },
    messages
  }

  return {
    page,
    close: async () => {
      socket.close()
      child.kill()
      await new Promise((resolve) => child.once("exit", resolve))
      rmSync(profile, { recursive: true, force: true })
    }
  }
}
