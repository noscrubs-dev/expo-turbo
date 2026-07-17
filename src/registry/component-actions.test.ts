import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { ActionError, RegistryError } from "../core/errors"
import {
  type ComponentActionStateStore,
  createComponentActionRegistry,
  createComponentActionRunner,
  defineComponentAction,
  defineComponentActionModule,
} from "./component-actions"

function memoryState(): ComponentActionStateStore {
  const values = new Map<string, unknown>()
  return {
    delete: (key) => {
      values.delete(key)
    },
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
  }
}

const increment = defineComponentAction({
  action: "increment",
  handler: ({ params, state }) => {
    const next = Number(state.get(params.key) ?? 0) + params.by
    state.set(params.key, next)
    return next
  },
  schema: z.object({ by: z.coerce.number().int(), key: z.string().min(1) }),
})

function registry() {
  return createComponentActionRegistry(
    defineComponentActionModule({
      actions: [increment],
      name: "counter-actions",
      version: "0.1.0",
    }),
  )
}

describe("component action registry", () => {
  test("preserves typed params/results and runs success/end lifecycle against injected state", async () => {
    const state = memoryState()
    const runner = createComponentActionRunner(registry(), state)
    const lifecycle: string[] = []

    const result = await runner.execute(
      { action: "increment", params: { by: "2", key: "count" } },
      {
        onEnd: (outcome) => lifecycle.push(`end:${outcome.status}`),
        onError: () => lifecycle.push("error"),
        onSuccess: (outcome) => lifecycle.push(`success:${outcome.result}`),
      },
    )

    expect(result).toBe(2)
    expect(state.get("count")).toBe(2)
    expect(lifecycle).toEqual(["success:2", "end:success"])
    expect(registry().actions).toEqual(["increment"])
    expect(registry().modules).toEqual([{ name: "counter-actions", version: "0.1.0" }])
  })

  test("serializes concurrent invocations and keeps the queue alive after failure", async () => {
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const sequenced = defineComponentAction({
      action: "sequenced",
      handler: async ({ params }) => {
        events.push(`start:${params.id}`)
        if (params.id === "first") await firstGate
        if (params.id === "broken") throw new Error("broken action")
        events.push(`finish:${params.id}`)
        return params.id
      },
      schema: z.object({ id: z.string() }),
    })
    const runner = createComponentActionRunner(
      createComponentActionRegistry(
        defineComponentActionModule({
          actions: [sequenced],
          name: "sequence",
          version: "0.1.0",
        }),
      ),
      memoryState(),
    )

    const first = runner.execute({ action: "sequenced", params: { id: "first" } })
    const broken = runner.execute(
      { action: "sequenced", params: { id: "broken" } },
      {
        onEnd: (outcome) => events.push(`end:${outcome.status}`),
        onError: () => events.push("error:broken"),
      },
    )
    const last = runner.execute({ action: "sequenced", params: { id: "last" } })

    await Promise.resolve()
    expect(events).toEqual(["start:first"])
    releaseFirst?.()
    await first
    await expect(broken).rejects.toBeInstanceOf(ActionError)
    await expect(last).resolves.toBe("last")
    expect(events).toEqual([
      "start:first",
      "finish:first",
      "start:broken",
      "error:broken",
      "end:error",
      "start:last",
      "finish:last",
    ])
  })

  test("runs error/end lifecycle for validation failures without exposing raw params", async () => {
    const events: string[] = []
    const runner = createComponentActionRunner(registry(), memoryState())

    await expect(
      runner.execute(
        { action: "increment", params: { by: "not-a-number", key: "count" } },
        {
          onEnd: (outcome) => events.push(`end:${outcome.status}`),
          onError: (outcome) =>
            events.push(`${outcome.error.code}:${outcome.error.context.action}`),
          onSuccess: () => events.push("success"),
        },
      ),
    ).rejects.toBeInstanceOf(ActionError)
    expect(events).toEqual(["action:increment", "end:error"])
  })

  test("executes a definition against an explicit scoped state store", async () => {
    const documentState = memoryState()
    const scopedState = memoryState()
    scopedState.set("step", 3)
    scopedState.set("target", "count")
    const runner = createComponentActionRunner(registry(), documentState)

    await runner.executeDefinition(
      increment,
      { by: { $state: "step" }, key: "{{state:target}}" },
      undefined,
      scopedState,
    )

    expect(documentState.get("count")).toBeUndefined()
    expect(scopedState.get("count")).toBe(3)
  })

  test("reports state-reference failures through the action error contract", async () => {
    const runner = createComponentActionRunner(registry(), memoryState())
    await expect(
      runner.executeDefinition(increment, {
        by: { $state: "missing" },
        key: "count",
      }),
    ).rejects.toBeInstanceOf(ActionError)
  })

  test("rejects duplicate modules/actions and definitions not owned by the runner", async () => {
    const module = defineComponentActionModule({
      actions: [increment],
      name: "counter-actions",
      version: "0.1.0",
    })
    expect(() => createComponentActionRegistry(module, module)).toThrow(/Duplicate.*module/)

    const duplicate = defineComponentAction({
      action: "increment",
      handler: () => 0,
      schema: z.object({}),
    })
    expect(() =>
      createComponentActionRegistry(
        module,
        defineComponentActionModule({
          actions: [duplicate],
          name: "duplicate",
          version: "0.1.0",
        }),
      ),
    ).toThrow(RegistryError)

    const runner = createComponentActionRunner(registry(), memoryState())
    await expect(runner.executeDefinition(duplicate, {})).rejects.toThrow(
      /Unknown component action/,
    )
  })
})
