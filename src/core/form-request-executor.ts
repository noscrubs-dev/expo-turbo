import type { FetchAdapter } from "../adapters"
import { ExpoTurboError, RequestError } from "./errors"
import type { FormRequestPlan } from "./form-request"
import {
  admitFormRequestPlan,
  executeAdmittedFormRequest,
  type FormRequestExecutionReport,
} from "./form-request-transport"

export type {
  FormRequestExecutionReport,
  FormResponseCandidate,
  FormResponseClassification,
} from "./form-request-transport"

export type FormRequestPlanFactory = (signal: AbortSignal) => FormRequestPlan

interface ActiveFormRequest {
  readonly controller: AbortController
}

/**
 * Owns one caller-scoped form transport lane. Each admitted execution
 * supersedes the previous execution in this instance, while separate instances
 * remain independent. Returned candidates are buffered but never applied.
 */
export class FormRequestExecutor {
  private active: ActiveFormRequest | undefined

  constructor(private readonly fetchAdapter: FetchAdapter) {}

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
      controller,
      owns: () => this.active === active && !controller.signal.aborted,
      release: () => {
        if (this.active === active) this.active = undefined
      },
    })
  }
}
