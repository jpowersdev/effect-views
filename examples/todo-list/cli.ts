#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpApiClient from "effect/http-api/HttpApiClient"

import * as DataApi from "./DataApi.js"

const baseUrl = process.env["TODOS_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? 3000}`

/** Prints a message and exits with a failure status. */
const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.sync(() => {
    process.exitCode = 1
  })))

/** A client for the JSON API, typed by the same contract the server implements. */
const client = HttpApiClient.make(DataApi.Api, { baseUrl })

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const { todosApi } = yield* client
    const todos = yield* todosApi.list()
    if (todos.length === 0) return yield* Console.log("Nothing to do")
    for (const todo of todos) yield* Console.log(`${todo.id}. ${todo.title}`)
  })).pipe(Command.withDescription("List the todos"))

const add = Command.make("add", { title: Argument.String("title") }, ({ title }) =>
  Effect.gen(function* () {
    const { todosApi } = yield* client
    const todo = yield* todosApi.create({ payload: { title } })
    yield* Console.log(`Added ${todo.id}. ${todo.title}`)
  }).pipe(
    // The same domain errors, and schema messages, that the form shows
    Effect.catchTags({
      DuplicateTodo: () => fail(`"${title}" is already on the list`),
      TodoListFull: ({ limit }) => fail(`The list is full at ${limit} todos`),
      SchemaError: (error) => fail(error.message.split("\n")[0]!)
    })
  )).pipe(Command.withDescription("Add a todo"))

const todos = Command.make("todos").pipe(
  Command.withDescription("Manage the todo list through its JSON API"),
  Command.withSubcommands([list, add])
)

Command.run(todos, { version: "0.1.0" }).pipe(
  Effect.catchTag("HttpClientError", () => fail(`Could not reach the todo list at ${baseUrl}; is it running?`)),
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain
)
