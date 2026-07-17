import type { z } from "zod"

import { ActionError, RegistryError } from "../core/errors"

export interface ComponentActionStateStore {
  delete(key: string): void
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface ComponentActionHandlerContext<Params> {
  readonly action: string
  readonly params: Params
  readonly state: ComponentActionStateStore
}

export interface RegistryComponentAction {
  readonly action: string
  decodeParams(params: unknown): unknown
  invoke(params: unknown, state: ComponentActionStateStore): Promise<unknown>
}

export interface DefinedComponentAction<Name extends string, Params, Result>
  extends RegistryComponentAction {
  readonly action: Name
  readonly types?: Readonly<{ params: Params; result: Result }>
}

export type ComponentActionParams<Action extends RegistryComponentAction> =
  Action extends DefinedComponentAction<string, infer Params, unknown> ? Params : never

export type ComponentActionResult<Action extends RegistryComponentAction> =
  Action extends DefinedComponentAction<string, unknown, infer Result> ? Result : never

export interface DefineComponentActionConfig<
  Name extends string,
  Schema extends z.ZodType,
  Result,
> {
  readonly action: Name
  readonly handler: (
    context: ComponentActionHandlerContext<z.output<Schema>>,
  ) => Result | Promise<Result>
  readonly schema: Schema
}

function validateActionName(action: string): void {
  if (!action.trim()) throw new RegistryError("Component action names must not be blank")
}

export function defineComponentAction<const Name extends string, Schema extends z.ZodType, Result>(
  config: DefineComponentActionConfig<Name, Schema, Result>,
): DefinedComponentAction<Name, z.input<Schema>, Awaited<Result>> {
  validateActionName(config.action)

  return Object.freeze({
    action: config.action,
    decodeParams(params: unknown): z.output<Schema> {
      const result = config.schema.safeParse(params)
      if (!result.success) {
        throw new ActionError(
          `Parameters failed validation for component action ${JSON.stringify(config.action)}`,
          { action: config.action },
        )
      }
      return result.data
    },
    async invoke(params: unknown, state: ComponentActionStateStore): Promise<Awaited<Result>> {
      return await config.handler(
        Object.freeze({ action: config.action, params: params as z.output<Schema>, state }),
      )
    },
  })
}

export interface ComponentActionModule<
  Name extends string = string,
  Actions extends readonly RegistryComponentAction[] = readonly RegistryComponentAction[],
> {
  readonly actions: Actions
  readonly name: Name
  readonly version: string
}

export function defineComponentActionModule<
  const Name extends string,
  const Actions extends readonly RegistryComponentAction[],
>(config: ComponentActionModule<Name, Actions>): ComponentActionModule<Name, Actions> {
  if (!config.name.trim()) throw new RegistryError("Component action modules require a name")
  if (!config.version.trim()) throw new RegistryError("Component action modules require a version")
  return Object.freeze({
    actions: Object.freeze([...config.actions]) as unknown as Actions,
    name: config.name,
    version: config.version,
  })
}

export interface ComponentActionRegistry<Action extends RegistryComponentAction = never> {
  readonly actions: readonly string[]
  readonly modules: readonly Readonly<{ name: string; version: string }>[]
  resolve(name: string): Action | undefined
  use<Next extends readonly RegistryComponentAction[]>(
    module: ComponentActionModule<string, Next>,
  ): ComponentActionRegistry<Action | Next[number]>
}

class ActionRegistry<Action extends RegistryComponentAction>
  implements ComponentActionRegistry<Action>
{
  readonly actions: readonly string[]
  readonly modules: readonly Readonly<{ name: string; version: string }>[]
  private readonly definitions = new Map<string, RegistryComponentAction>()

  constructor(private readonly actionModules: readonly ComponentActionModule[]) {
    const moduleNames = new Set<string>()
    for (const module of actionModules) {
      if (moduleNames.has(module.name)) {
        throw new RegistryError(`Duplicate component action module ${JSON.stringify(module.name)}`)
      }
      moduleNames.add(module.name)
      for (const action of module.actions) {
        validateActionName(action.action)
        if (this.definitions.has(action.action)) {
          throw new RegistryError(`Duplicate component action ${JSON.stringify(action.action)}`, {
            action: action.action,
          })
        }
        this.definitions.set(action.action, action)
      }
    }
    this.actions = Object.freeze([...this.definitions.keys()].sort())
    this.modules = Object.freeze(
      actionModules
        .map((module) => Object.freeze({ name: module.name, version: module.version }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    )
  }

  resolve(name: string): Action | undefined {
    return this.definitions.get(name) as Action | undefined
  }

  use<Next extends readonly RegistryComponentAction[]>(
    module: ComponentActionModule<string, Next>,
  ): ComponentActionRegistry<Action | Next[number]> {
    return new ActionRegistry<Action | Next[number]>([...this.actionModules, module])
  }
}

type ActionsFromModules<Modules extends readonly ComponentActionModule[]> =
  Modules[number]["actions"][number]

export function createComponentActionRegistry<
  const Modules extends readonly ComponentActionModule[],
>(...modules: Modules): ComponentActionRegistry<ActionsFromModules<Modules>> {
  return new ActionRegistry<ActionsFromModules<Modules>>(modules)
}

export interface ComponentActionSuccess<Result> {
  readonly action: string
  readonly result: Result
  readonly state: ComponentActionStateStore
  readonly status: "success"
}

export interface ComponentActionFailure {
  readonly action: string
  readonly error: ActionError
  readonly state: ComponentActionStateStore
  readonly status: "error"
}

export type ComponentActionOutcome<Result> = ComponentActionFailure | ComponentActionSuccess<Result>

export interface ComponentActionLifecycle<Result> {
  readonly onEnd?: (outcome: ComponentActionOutcome<Result>) => unknown
  readonly onError?: (outcome: ComponentActionFailure) => unknown
  readonly onSuccess?: (outcome: ComponentActionSuccess<Result>) => unknown
}

export interface ComponentActionExecutor {
  executeDefinition<Definition extends RegistryComponentAction>(
    definition: Definition,
    params: ComponentActionParams<Definition>,
    lifecycle?: ComponentActionLifecycle<ComponentActionResult<Definition>>,
  ): Promise<ComponentActionResult<Definition>>
}

function actionError(action: string, message: string, cause: unknown): ActionError {
  if (cause instanceof ActionError) return cause
  return new ActionError(message, { action }, { cause })
}

export class ComponentActionRunner<Action extends RegistryComponentAction>
  implements ComponentActionExecutor
{
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly registry: ComponentActionRegistry<Action>,
    private readonly state: ComponentActionStateStore,
  ) {}

  execute<Name extends Action["action"]>(
    request: Readonly<{
      action: Name
      params: ComponentActionParams<Extract<Action, { readonly action: Name }>>
    }>,
    lifecycle?: ComponentActionLifecycle<
      ComponentActionResult<Extract<Action, { readonly action: Name }>>
    >,
  ): Promise<ComponentActionResult<Extract<Action, { readonly action: Name }>>> {
    return this.enqueue(
      request.action,
      request.params,
      lifecycle as unknown as ComponentActionLifecycle<unknown> | undefined,
    ) as Promise<ComponentActionResult<Extract<Action, { readonly action: Name }>>>
  }

  executeDefinition<Definition extends RegistryComponentAction>(
    definition: Definition,
    params: ComponentActionParams<Definition>,
    lifecycle?: ComponentActionLifecycle<ComponentActionResult<Definition>>,
  ): Promise<ComponentActionResult<Definition>> {
    return this.enqueue(
      definition.action,
      params,
      lifecycle as unknown as ComponentActionLifecycle<unknown> | undefined,
      definition,
    ) as Promise<ComponentActionResult<Definition>>
  }

  private enqueue(
    action: string,
    params: unknown,
    lifecycle: ComponentActionLifecycle<unknown> | undefined,
    expectedDefinition?: RegistryComponentAction,
  ): Promise<unknown> {
    const execution = this.tail.then(() =>
      this.executeNow(action, params, lifecycle, expectedDefinition),
    )
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    )
    return execution
  }

  private async executeNow(
    action: string,
    params: unknown,
    lifecycle: ComponentActionLifecycle<unknown> | undefined,
    expectedDefinition: RegistryComponentAction | undefined,
  ): Promise<unknown> {
    let outcome: ComponentActionOutcome<unknown>
    try {
      const definition = this.registry.resolve(action)
      if (!definition || (expectedDefinition && definition !== expectedDefinition)) {
        throw new ActionError(`Unknown component action ${JSON.stringify(action)}`, { action })
      }
      const decoded = definition.decodeParams(params)
      const result = await definition.invoke(decoded, this.state)
      const success = Object.freeze({
        action,
        result,
        state: this.state,
        status: "success" as const,
      })
      await lifecycle?.onSuccess?.(success)
      outcome = success
    } catch (error) {
      let failure = Object.freeze({
        action,
        error: actionError(action, `Component action ${JSON.stringify(action)} failed`, error),
        state: this.state,
        status: "error" as const,
      })
      try {
        await lifecycle?.onError?.(failure)
      } catch (lifecycleError) {
        failure = Object.freeze({
          ...failure,
          error: new ActionError(
            `Component action ${JSON.stringify(action)} onError lifecycle failed`,
            { action },
            { cause: new AggregateError([failure.error, lifecycleError]) },
          ),
        })
      }
      outcome = failure
    }

    try {
      await lifecycle?.onEnd?.(outcome)
    } catch (error) {
      const causes = outcome.status === "error" ? [outcome.error, error] : [error]
      throw new ActionError(
        `Component action ${JSON.stringify(action)} onEnd lifecycle failed`,
        { action },
        { cause: new AggregateError(causes) },
      )
    }
    if (outcome.status === "error") throw outcome.error
    return outcome.result
  }
}

export function createComponentActionRunner<Action extends RegistryComponentAction>(
  registry: ComponentActionRegistry<Action>,
  state: ComponentActionStateStore,
): ComponentActionRunner<Action> {
  return new ComponentActionRunner(registry, state)
}
