import type { FetchAdapter } from "../adapters"
import { ExpoTurboError, RequestError } from "./errors"
import type { FormRequestPlan } from "./form-request"
import {
  admitFormRequestPlan,
  executeAdmittedFormRequest,
  type FormRequestExecutionReport,
} from "./form-request-transport"
import type { RecentRequestIds } from "./recent-request-ids"
import { type RequestLifecycle, requestLifecycleOption } from "./request-lifecycle"

export type {
  FormRequestExecutionReport,
  FormResponseCandidate,
  FormResponseClassification,
} from "./form-request-transport"

export type FormRequestPlanFactory = (signal: AbortSignal) => FormRequestPlan

interface ActiveFormRequest {
  readonly controller: AbortController
}

export interface FormRequestExecutorOptions {
  readonly recentRequestIds?: RecentRequestIds
  readonly requestLifecycle?: RequestLifecycle
}

/**
 * Owns one caller-scoped form transport lane. Each admitted execution
 * supersedes the previous execution in this instance, while separate instances
 * remain independent. Returned candidates are buffered but never applied.
 */
export class FormRequestExecutor {
  private active: ActiveFormRequest | undefined
  private readonly recentRequestIds: RecentRequestIds | undefined
  private readonly requestLifecycle: RequestLifecycle | undefined

  constructor(
    private readonly fetchAdapter: FetchAdapter,
    options: FormRequestExecutorOptions = {},
  ) {
    this.requestLifecycle = requestLifecycleOption(options, "Form request executor")
    this.recentRequestIds = options.recentRequestIds
  }

  cancel(): void {
    const active = this.active
    if (!active) return
    if (this.active === active) this.active = undefined
    active.controller.abort()
  }

  async execute(createPlan: FormRequestPlanFactory): Promise<FormRequestExecutionReport> {
    if (typeof createPlan !== "function") {
      throw new RequestError("Form request executor requires a plan factory")
    }

    const controller = new AbortController()
    let plan: FormRequestPlan
    try {
      plan = admitFormRequestPlan(createPlan(controller.signal), controller.signal)
    } catch (error) {
      controller.abort()
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form request planning failed")
    }

    const active: ActiveFormRequest = { controller }
    const previous = this.active
    this.active = active
    // Install this execution before aborting the displaced one. An abort
    // listener may synchronously start newer work, which must remain current.
    previous?.controller.abort()
    return executeAdmittedFormRequest(this.fetchAdapter, plan, {
      beforeRequest: () => {
        if (this.active !== active || controller.signal.aborted) return false
        this.recentRequestIds?.add(plan.request.headers["X-Turbo-Request-Id"] as string)
        return true
      },
      controller,
      owns: () => this.active === active && !controller.signal.aborted,
      release: () => {
        if (this.active === active) this.active = undefined
      },
      ...(this.requestLifecycle
        ? {
            requestContext: {
              kind: "form",
              requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
            },
            requestLifecycle: this.requestLifecycle,
          }
        : {}),
    })
  }
}
