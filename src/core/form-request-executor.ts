import type { FetchAdapter, TurboResponse } from "../adapters"
import { ContentTypeError, ExpoTurboError, RequestError } from "./errors"
import type { FormRequestPlan, FormSubmissionMethod } from "./form-request"
import { isAdmittedFormRequestPlan } from "./form-request-plan"
import {
  EXPO_TURBO_MIME_TYPE,
  resolveSameOriginProtocolUrl,
  responseContentType,
  TURBO_STREAM_MIME_TYPE,
} from "./protocol-request"

export type FormResponseClassification = "client-error" | "server-error" | "success"

export type FormRequestPlanFactory = (signal: AbortSignal) => FormRequestPlan

interface FormExecutionRequestReport {
  readonly effectiveMethod: FormSubmissionMethod
  readonly requestId: string
  readonly requestedUrl: string
  readonly sourceMethod: FormSubmissionMethod
}

interface FormExecutionResponseReport extends FormExecutionRequestReport {
  readonly classification: FormResponseClassification
  readonly redirected: boolean
  readonly responseStatus: number
  readonly url: string
}

export type FormResponseCandidate =
  | (FormExecutionResponseReport & Readonly<{ status: "empty" }>)
  | (FormExecutionResponseReport &
      Readonly<{
        body: string
        contentType: typeof EXPO_TURBO_MIME_TYPE
        status: "xml"
      }>)
  | (FormExecutionResponseReport &
      Readonly<{
        body: string
        contentType: typeof TURBO_STREAM_MIME_TYPE
        status: "stream"
      }>)

export type FormRequestExecutionReport =
  | FormResponseCandidate
  | (FormExecutionRequestReport &
      Readonly<{
        status: "canceled"
        url: string
      }>)

interface ActiveFormRequest {
  readonly controller: AbortController
  readonly report: FormExecutionRequestReport
  url: string
}

type ActiveOperationResult<T> =
  | Readonly<{ status: "canceled" }>
  | Readonly<{ error: unknown; status: "rejected" }>
  | Readonly<{ status: "resolved"; value: T }>

const METHODS = new Set<FormSubmissionMethod>(["DELETE", "GET", "PATCH", "POST", "PUT"])

function classifyResponse(
  status: number,
  method: FormSubmissionMethod,
): FormResponseClassification {
  if (status >= 200 && status < 300) return "success"
  if (status >= 400 && status < 500) return "client-error"
  if (status >= 500 && status < 600) return "server-error"
  throw new RequestError("Form response status is not actionable", {
    method,
    responseStatus: status,
  })
}

function admittedPlan(value: unknown, signal: AbortSignal): FormRequestPlan {
  if (!isAdmittedFormRequestPlan(value)) {
    throw new RequestError("Form request executor requires a planner-issued request plan")
  }
  const plan = value as Partial<FormRequestPlan>
  if (
    !plan.request ||
    typeof plan.request !== "object" ||
    Array.isArray(plan.request) ||
    !Object.isFrozen(plan.request) ||
    plan.request.signal !== signal ||
    !METHODS.has(plan.effectiveMethod as FormSubmissionMethod) ||
    !METHODS.has(plan.sourceMethod as FormSubmissionMethod) ||
    !Array.isArray(plan.entries) ||
    !Object.isFrozen(plan.entries) ||
    typeof plan.request.method !== "string" ||
    typeof plan.request.url !== "string" ||
    !plan.request.headers ||
    typeof plan.request.headers !== "object" ||
    Array.isArray(plan.request.headers) ||
    !Object.isFrozen(plan.request.headers) ||
    (plan.request.body !== undefined &&
      (typeof plan.request.body !== "object" ||
        Array.isArray(plan.request.body) ||
        !Object.isFrozen(plan.request.body)))
  ) {
    throw new RequestError("Form request executor received an invalid request plan")
  }
  const requestId = plan.request.headers["X-Turbo-Request-Id"]
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new RequestError("Form request plan requires request-ID metadata")
  }
  return plan as FormRequestPlan
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
    active.controller.abort()
    this.active = undefined
  }

  async execute(createPlan: FormRequestPlanFactory): Promise<FormRequestExecutionReport> {
    if (typeof createPlan !== "function") {
      throw new RequestError("Form request executor requires a plan factory")
    }

    const controller = new AbortController()
    let plan: FormRequestPlan
    try {
      plan = admittedPlan(createPlan(controller.signal), controller.signal)
    } catch (error) {
      controller.abort()
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form request planning failed")
    }

    const report = Object.freeze({
      effectiveMethod: plan.effectiveMethod,
      requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
      requestedUrl: plan.request.url,
      sourceMethod: plan.sourceMethod,
    })
    const active: ActiveFormRequest = {
      controller,
      report,
      url: plan.request.url,
    }

    this.cancel()
    this.active = active
    let responseStatus: number | undefined

    try {
      const fetched = await this.waitFor(active, this.fetchAdapter.fetch(plan.request))
      if (fetched.status === "canceled") return this.canceled(active)
      if (fetched.status === "rejected") throw fetched.error
      const response = fetched.value

      responseStatus = response.status
      const finalUrl = this.finalUrl(response, active)
      active.url = finalUrl
      const classification = classifyResponse(response.status, report.effectiveMethod)
      const redirected = response.redirected || finalUrl !== report.requestedUrl

      if (response.status === 204) {
        return this.complete(active, {
          classification,
          redirected,
          responseStatus: response.status,
          status: "empty",
          url: finalUrl,
        })
      }

      let contentType: typeof EXPO_TURBO_MIME_TYPE | typeof TURBO_STREAM_MIME_TYPE | undefined
      if (response.status !== 201) {
        contentType = this.contentType(response, report.effectiveMethod, plan)
      }
      const buffered = await this.waitFor(active, response.text())
      if (buffered.status === "canceled") return this.canceled(active)
      if (buffered.status === "rejected") throw buffered.error
      const body = buffered.value
      if (typeof body !== "string") {
        throw new RequestError("Form response body must be text", {
          method: report.effectiveMethod,
          responseStatus: response.status,
        })
      }
      if (response.status === 201 && body.trim() === "") {
        return this.complete(active, {
          classification,
          redirected,
          responseStatus: response.status,
          status: "empty",
          url: finalUrl,
        })
      }
      contentType ??= this.contentType(response, report.effectiveMethod, plan)

      return this.complete(active, {
        body,
        classification,
        contentType,
        redirected,
        responseStatus: response.status,
        status: contentType === EXPO_TURBO_MIME_TYPE ? "xml" : "stream",
        url: finalUrl,
      })
    } catch (error) {
      if (controller.signal.aborted || !this.owns(active)) return this.canceled(active)
      this.release(active)
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form request failed", {
        method: report.effectiveMethod,
        ...(responseStatus !== undefined ? { responseStatus } : {}),
      })
    }
  }

  private canceled(active: ActiveFormRequest): FormRequestExecutionReport {
    this.release(active)
    return Object.freeze({
      ...active.report,
      status: "canceled",
      url: active.url,
    })
  }

  private complete(
    active: ActiveFormRequest,
    candidate:
      | Readonly<{
          classification: FormResponseClassification
          redirected: boolean
          responseStatus: number
          status: "empty"
          url: string
        }>
      | Readonly<{
          body: string
          classification: FormResponseClassification
          contentType: typeof EXPO_TURBO_MIME_TYPE | typeof TURBO_STREAM_MIME_TYPE
          redirected: boolean
          responseStatus: number
          status: "stream" | "xml"
          url: string
        }>,
  ): FormResponseCandidate {
    this.release(active)
    return Object.freeze({ ...active.report, ...candidate }) as FormResponseCandidate
  }

  private contentType(
    response: TurboResponse,
    method: FormSubmissionMethod,
    plan: FormRequestPlan,
  ): typeof EXPO_TURBO_MIME_TYPE | typeof TURBO_STREAM_MIME_TYPE {
    const contentType = responseContentType(response)
    if (contentType !== EXPO_TURBO_MIME_TYPE && contentType !== TURBO_STREAM_MIME_TYPE) {
      throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE} or ${TURBO_STREAM_MIME_TYPE}`, {
        contentType: contentType ?? "missing",
        method,
        responseStatus: response.status,
      })
    }
    const accept = plan.request.headers.Accept
    if (
      contentType === TURBO_STREAM_MIME_TYPE &&
      (typeof accept !== "string" ||
        !accept.split(",").some((accepted) => accepted.trim() === TURBO_STREAM_MIME_TYPE))
    ) {
      throw new ContentTypeError("Form response returned an unrequested Turbo Stream", {
        contentType,
        method,
        responseStatus: response.status,
      })
    }
    return contentType
  }

  private async waitFor<T>(
    active: ActiveFormRequest,
    operation: Promise<T>,
  ): Promise<ActiveOperationResult<T>> {
    const settled: Promise<ActiveOperationResult<T>> = Promise.resolve(operation).then(
      (value): ActiveOperationResult<T> => Object.freeze({ status: "resolved", value }),
      (error: unknown): ActiveOperationResult<T> => Object.freeze({ error, status: "rejected" }),
    )
    if (!this.owns(active)) return Object.freeze({ status: "canceled" })

    let cancel = () => {}
    const canceled = new Promise<ActiveOperationResult<T>>((resolve) => {
      cancel = () => resolve(Object.freeze({ status: "canceled" }))
      active.controller.signal.addEventListener("abort", cancel, { once: true })
      if (!this.owns(active)) cancel()
    })
    const result = await Promise.race([settled, canceled])
    active.controller.signal.removeEventListener("abort", cancel)
    return result
  }

  private finalUrl(response: TurboResponse, active: ActiveFormRequest): string {
    if (typeof response.url !== "string" || response.url.trim() === "") {
      throw new RequestError("Form response requires a final URL", {
        method: active.report.effectiveMethod,
        responseStatus: response.status,
      })
    }
    return resolveSameOriginProtocolUrl(
      response.url,
      active.report.requestedUrl,
      active.report.requestedUrl,
      {
        method: active.report.effectiveMethod,
        responseStatus: response.status,
      },
    )
  }

  private owns(active: ActiveFormRequest): boolean {
    return this.active === active && !active.controller.signal.aborted
  }

  private release(active: ActiveFormRequest): void {
    if (this.active === active) this.active = undefined
  }
}
