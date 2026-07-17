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

export interface FormRequestTransportOwnership {
  readonly controller: AbortController
  owns(): boolean
  release(): void
}

type ActiveOperationResult<T> =
  | Readonly<{ status: "canceled" }>
  | Readonly<{ error: unknown; status: "rejected" }>
  | Readonly<{ status: "resolved"; value: T }>

const METHODS = new Set<FormSubmissionMethod>(["DELETE", "GET", "PATCH", "POST", "PUT"])

export function admitFormRequestPlan(value: unknown, signal: AbortSignal): FormRequestPlan {
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

/** Internal one-fetch transport shared by caller-scoped and destination-scoped execution. */
export async function executeAdmittedFormRequest(
  fetchAdapter: FetchAdapter,
  plan: FormRequestPlan,
  ownership: FormRequestTransportOwnership,
): Promise<FormRequestExecutionReport> {
  const report = Object.freeze({
    effectiveMethod: plan.effectiveMethod,
    requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
    requestedUrl: plan.request.url,
    sourceMethod: plan.sourceMethod,
  })
  let url = plan.request.url
  let responseStatus: number | undefined

  const release = () => ownership.release()
  const canceled = (): FormRequestExecutionReport => {
    release()
    return Object.freeze({ ...report, status: "canceled", url })
  }
  const complete = (
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
  ): FormRequestExecutionReport => {
    if (!ownership.owns()) return canceled()
    release()
    return Object.freeze({ ...report, ...candidate }) as FormResponseCandidate
  }

  try {
    if (!ownership.owns()) return canceled()
    const fetched = await waitFor(ownership, fetchAdapter.fetch(plan.request))
    if (fetched.status === "canceled") return canceled()
    if (fetched.status === "rejected") throw fetched.error
    const response = fetched.value

    responseStatus = response.status
    url = finalUrl(response, report)
    const classification = classifyResponse(response.status, report.effectiveMethod)
    const redirected = response.redirected || url !== report.requestedUrl

    if (response.status === 204) {
      return complete({
        classification,
        redirected,
        responseStatus: response.status,
        status: "empty",
        url,
      })
    }

    let contentType: typeof EXPO_TURBO_MIME_TYPE | typeof TURBO_STREAM_MIME_TYPE | undefined
    if (response.status !== 201) {
      contentType = admittedContentType(response, report.effectiveMethod, plan)
    }
    const buffered = await waitFor(ownership, response.text())
    if (buffered.status === "canceled") return canceled()
    if (buffered.status === "rejected") throw buffered.error
    const body = buffered.value
    if (typeof body !== "string") {
      throw new RequestError("Form response body must be text", {
        method: report.effectiveMethod,
        responseStatus: response.status,
      })
    }
    if (response.status === 201 && body.trim() === "") {
      return complete({
        classification,
        redirected,
        responseStatus: response.status,
        status: "empty",
        url,
      })
    }
    contentType ??= admittedContentType(response, report.effectiveMethod, plan)

    return complete({
      body,
      classification,
      contentType,
      redirected,
      responseStatus: response.status,
      status: contentType === EXPO_TURBO_MIME_TYPE ? "xml" : "stream",
      url,
    })
  } catch (error) {
    if (ownership.controller.signal.aborted || !ownership.owns()) return canceled()
    release()
    if (error instanceof ExpoTurboError) throw error
    throw new RequestError("Form request failed", {
      method: report.effectiveMethod,
      ...(responseStatus !== undefined ? { responseStatus } : {}),
    })
  }
}

function admittedContentType(
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

function finalUrl(response: TurboResponse, report: FormExecutionRequestReport): string {
  if (typeof response.url !== "string" || response.url.trim() === "") {
    throw new RequestError("Form response requires a final URL", {
      method: report.effectiveMethod,
      responseStatus: response.status,
    })
  }
  return resolveSameOriginProtocolUrl(response.url, report.requestedUrl, report.requestedUrl, {
    method: report.effectiveMethod,
    responseStatus: response.status,
  })
}

async function waitFor<T>(
  ownership: FormRequestTransportOwnership,
  operation: Promise<T>,
): Promise<ActiveOperationResult<T>> {
  const settled: Promise<ActiveOperationResult<T>> = Promise.resolve(operation).then(
    (value): ActiveOperationResult<T> => Object.freeze({ status: "resolved", value }),
    (error: unknown): ActiveOperationResult<T> => Object.freeze({ error, status: "rejected" }),
  )
  if (!ownership.owns()) return Object.freeze({ status: "canceled" })

  let cancel = () => {}
  const canceled = new Promise<ActiveOperationResult<T>>((resolve) => {
    cancel = () => resolve(Object.freeze({ status: "canceled" }))
    ownership.controller.signal.addEventListener("abort", cancel, { once: true })
    if (!ownership.owns()) cancel()
  })
  const result = await Promise.race([settled, canceled])
  ownership.controller.signal.removeEventListener("abort", cancel)
  return ownership.owns() ? result : Object.freeze({ status: "canceled" })
}
