import type { z } from "zod"

import { ActionError, RegistryError } from "./errors"
import type { DocumentSession } from "./session"
import type { ProtocolElement, ProtocolNode } from "./tree"

const RESERVED_STREAM_ACTIONS = new Set([
  "after",
  "append",
  "before",
  "prepend",
  "refresh",
  "remove",
  "replace",
  "update",
])

export interface CustomStreamActionResult {
  readonly appliedTargets?: number
  readonly status: "applied" | "noop"
}

export interface CustomStreamActionContext<Params> {
  readonly action: string
  readonly params: Params
  readonly session: DocumentSession
  readonly stream: ProtocolElement
  readonly targets: readonly ProtocolElement[]
  readonly template: readonly ProtocolNode[]
}

export interface DefineStreamActionConfig<Name extends string, Schema extends z.ZodObject> {
  readonly action: Name
  readonly handler: (
    context: CustomStreamActionContext<z.output<Schema>>,
  ) => CustomStreamActionResult | PromiseLike<CustomStreamActionResult | undefined> | undefined
  readonly schema: Schema
}

export interface DefinedStreamAction<
  Name extends string = string,
  Schema extends z.ZodObject = z.ZodObject,
> {
  readonly action: Name
  readonly handler: (
    context: CustomStreamActionContext<z.output<Schema>>,
  ) => CustomStreamActionResult | PromiseLike<CustomStreamActionResult | undefined> | undefined
  decodeParams(params: Readonly<Record<string, string>>): z.output<Schema>
}

function validateActionName(action: string): void {
  if (!action.trim()) throw new RegistryError("Stream action names must not be blank")
  if (RESERVED_STREAM_ACTIONS.has(action)) {
    throw new RegistryError(`Stream action ${JSON.stringify(action)} is reserved`, { action })
  }
}

export function defineStreamAction<const Name extends string, Schema extends z.ZodObject>(
  config: DefineStreamActionConfig<Name, Schema>,
): DefinedStreamAction<Name, Schema> {
  validateActionName(config.action)
  const admittedParams = new Set(Object.keys(config.schema.shape))

  return Object.freeze({
    action: config.action,
    decodeParams(params: Readonly<Record<string, string>>): z.output<Schema> {
      for (const name of Object.keys(params)) {
        if (!admittedParams.has(name)) {
          throw new ActionError(
            `Unknown parameter ${JSON.stringify(name)} for Stream action ${JSON.stringify(config.action)}`,
            { action: config.action, target: name },
          )
        }
      }
      const result = config.schema.safeParse(params)
      if (!result.success) {
        throw new ActionError(
          `Parameters failed validation for Stream action ${JSON.stringify(config.action)}`,
          { action: config.action },
        )
      }
      return result.data
    },
    handler: config.handler,
  })
}

export interface CustomStreamActionRegistry<Action extends DefinedStreamAction = never> {
  readonly actions: readonly string[]
  resolve(name: string): Action | undefined
  use<Next extends DefinedStreamAction>(action: Next): CustomStreamActionRegistry<Action | Next>
}

class StreamActionRegistry<Action extends DefinedStreamAction>
  implements CustomStreamActionRegistry<Action>
{
  readonly actions: readonly string[]
  private readonly definitions = new Map<string, DefinedStreamAction>()

  constructor(actions: readonly DefinedStreamAction[]) {
    for (const action of actions) {
      validateActionName(action.action)
      if (this.definitions.has(action.action)) {
        throw new RegistryError(`Duplicate Stream action ${JSON.stringify(action.action)}`, {
          action: action.action,
        })
      }
      this.definitions.set(action.action, action)
    }
    this.actions = Object.freeze([...this.definitions.keys()].sort())
  }

  resolve(name: string): Action | undefined {
    return this.definitions.get(name) as Action | undefined
  }

  use<Next extends DefinedStreamAction>(action: Next): CustomStreamActionRegistry<Action | Next> {
    return new StreamActionRegistry<Action | Next>([...this.definitions.values(), action])
  }
}

export function createStreamActionRegistry<const Actions extends readonly DefinedStreamAction[]>(
  ...actions: Actions
): CustomStreamActionRegistry<Actions[number]> {
  return new StreamActionRegistry<Actions[number]>(actions)
}
