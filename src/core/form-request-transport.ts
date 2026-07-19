import type { FetchAdapter, TurboRequest, TurboResponse } from "../adapters"
import { ContentTypeError, ExpoTurboError, RequestError } from "./errors"
import {
  FORM_TEXT_PLAIN,
  FORM_URL_ENCODED,
  type FormRequestPlan,
  type FormSubmissionMethod,
  MAX_FORM_TEXT_PLAIN_BODY_BYTES,
} from "./form-request"
import {
  isAdmittedFormRequestPlan,
  admitFormRequestPlan as markFormRequestPlan,
} from "./form-request-plan"
import {
  EXPO_TURBO_MIME_TYPE,
  resolveSameOriginProtocolUrl,
  responseContentType,
  TURBO_STREAM_MIME_TYPE,
} from "./protocol-request"
import {
  fetchWithRequestLifecycle,
  type RequestLifecycle,
  type RequestLifecycleContext,
  RequestLifecycleTransportError,
} from "./request-lifecycle"

export type FormResponseClassification = "client-error" | "server-error" | "success"

interface FormExecutionRequestReport {
  readonly effectiveMethod: FormSubmissionMethod
  readonly requestId: string
  readonly requestedUrl: string
  readonly sourceMethod: FormSubmissionMethod
  readonly transportMethod: FormSubmissionMethod
}

interface FormExecutionResponseReport extends FormExecutionRequestReport {
  readonly classification: FormResponseClassification
  readonly redirected: boolean
  readonly responseStatus: number
  readonly url: string
}

export interface FormAdmittedResponse extends FormExecutionResponseReport {
  readonly contentType?: string
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
        redirected: boolean
        responseStatus: number
        status: "prevented"
        url: string
      }>)
  | (FormExecutionRequestReport &
      Readonly<{
        status: "canceled"
        url: string
      }>)

export interface FormRequestTransportOwnership {
  readonly beforeRequest?: (request: TurboRequest) => boolean | undefined
  readonly beforeResponseBody?: (response: FormAdmittedResponse) => undefined
  readonly controller: AbortController
  /** Internal controller mode: the caller releases only after synchronous application. */
  readonly retainCandidate?: boolean
  readonly requestContext?: Extract<RequestLifecycleContext, Readonly<{ kind: "form" }>>
  readonly requestLifecycle?: RequestLifecycle
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

export function replaceAdmittedFormRequest(
  plan: FormRequestPlan,
  request: TurboRequest,
): FormRequestPlan {
  return markFormRequestPlan(Object.freeze({ ...plan, request }) as FormRequestPlan)
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
  let request = plan.request
  let report = requestReport(plan, request)
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
    if (!ownership.retainCandidate) release()
    return Object.freeze({ ...report, ...candidate }) as FormResponseCandidate
  }

  try {
    if (!ownership.owns()) return canceled()
    let response: TurboResponse
    if (ownership.requestLifecycle) {
      const fetched = await fetchWithRequestLifecycle({
        admission: {
          admitUrl: (candidate) => {
            const admitted = resolveSameOriginProtocolUrl(
              candidate,
              plan.request.url,
              plan.request.url,
              { method: plan.effectiveMethod },
            )
            if (admitted.includes("#")) {
              throw new RequestError("Form request lifecycle fragments are unsupported", {
                method: plan.effectiveMethod,
              })
            }
            return admitted
          },
          allowBody: true,
          allowedMethods: [...METHODS],
          maxBodyBytes: MAX_FORM_TEXT_PLAIN_BODY_BYTES,
          protectedHeaders: Object.keys(plan.request.headers).filter(
            (name) => name.toLowerCase() !== "accept",
          ),
        },
        beforeFetch: (candidate) => {
          admitLifecycleFormRequest(candidate)
          return ownership.beforeRequest?.(candidate)
        },
        context:
          ownership.requestContext ??
          Object.freeze({
            kind: "form",
            requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
          }),
        fetchAdapter,
        lifecycle: ownership.requestLifecycle,
        request: plan.request,
      })
      request = fetched.request
      report = requestReport(plan, request)
      url = request.url
      if (fetched.status === "canceled") return canceled()
      response = fetched.response
      if (fetched.status === "prevented") {
        responseStatus = response.status
        url = finalUrl(response, report)
        release()
        return Object.freeze({
          ...report,
          redirected: response.redirected || url !== report.requestedUrl,
          responseStatus: response.status,
          status: "prevented",
          url,
        })
      }
    } else {
      if (ownership.beforeRequest) {
        const proceed = ownership.beforeRequest(request)
        if (proceed !== undefined && typeof proceed !== "boolean") {
          throw new RequestError("Form request admission must return a boolean", {
            method: report.transportMethod,
          })
        }
        if (proceed === false || !ownership.owns()) return canceled()
      }
      const fetched = await waitFor(ownership, fetchAdapter.fetch(request))
      if (fetched.status === "canceled") return canceled()
      if (fetched.status === "rejected") throw fetched.error
      response = fetched.value
    }

    responseStatus = response.status
    url = finalUrl(response, report)
    const classification = classifyResponse(response.status, report.transportMethod)
    const redirected = response.redirected || url !== report.requestedUrl
    const rawContentType = responseContentType(response)

    if (ownership.beforeResponseBody) {
      const callbackResult = ownership.beforeResponseBody(
        Object.freeze({
          ...report,
          classification,
          ...(rawContentType !== undefined ? { contentType: rawContentType } : {}),
          redirected,
          responseStatus: response.status,
          url,
        }),
      )
      if (callbackResult !== undefined) {
        throw new RequestError("Form response admission callback must not return a value", {
          method: report.transportMethod,
          responseStatus: response.status,
        })
      }
      if (!ownership.owns()) return canceled()
    }

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
      contentType = admittedContentType(response, report.transportMethod, request)
    }
    const buffered = await waitFor(ownership, response.text())
    if (buffered.status === "canceled") return canceled()
    if (buffered.status === "rejected") throw buffered.error
    const body = buffered.value
    if (typeof body !== "string") {
      throw new RequestError("Form response body must be text", {
        method: report.transportMethod,
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
    contentType ??= admittedContentType(response, report.transportMethod, request)

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
    if (error instanceof RequestLifecycleTransportError) {
      throw error.relabel("Form request failed", {
        method: report.transportMethod,
        ...(responseStatus !== undefined ? { responseStatus } : {}),
      })
    }
    if (error instanceof ExpoTurboError) throw error
    throw new RequestError("Form request failed", {
      method: report.transportMethod,
      ...(responseStatus !== undefined ? { responseStatus } : {}),
    })
  }
}

function admitLifecycleFormRequest(request: TurboRequest): void {
  const accept = requestHeader(request, "accept")
  const accepted = new Set(accept?.split(",").map((value) => value.trim()))
  if (!accepted.has(EXPO_TURBO_MIME_TYPE)) {
    throw new RequestError("Form requests must accept Expo Turbo XML", {
      method: request.method,
    })
  }
  if (request.method !== "GET" && !accepted.has(TURBO_STREAM_MIME_TYPE)) {
    throw new RequestError("Unsafe form requests must accept Turbo Streams", {
      method: request.method,
    })
  }
  if (
    request.body &&
    (typeof request.body.value !== "string" ||
      (request.body.contentType !== `${FORM_URL_ENCODED};charset=UTF-8` &&
        request.body.contentType !== FORM_TEXT_PLAIN))
  ) {
    throw new RequestError("Form request lifecycle body encoding is unsupported", {
      method: request.method,
    })
  }
}

function admittedContentType(
  response: TurboResponse,
  method: FormSubmissionMethod,
  request: TurboRequest,
): typeof EXPO_TURBO_MIME_TYPE | typeof TURBO_STREAM_MIME_TYPE {
  const contentType = responseContentType(response)
  if (contentType !== EXPO_TURBO_MIME_TYPE && contentType !== TURBO_STREAM_MIME_TYPE) {
    throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE} or ${TURBO_STREAM_MIME_TYPE}`, {
      contentType: contentType ?? "missing",
      method,
      responseStatus: response.status,
    })
  }
  const accept = requestHeader(request, "accept")
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

function requestReport(plan: FormRequestPlan, request: TurboRequest): FormExecutionRequestReport {
  const transportMethod = request.method.toUpperCase() as FormSubmissionMethod
  if (!METHODS.has(transportMethod)) {
    throw new RequestError("Form request transport method is unsupported", {
      method: request.method,
    })
  }
  return Object.freeze({
    effectiveMethod: plan.effectiveMethod,
    requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
    requestedUrl: request.url,
    sourceMethod: plan.sourceMethod,
    transportMethod,
  })
}

function finalUrl(response: TurboResponse, report: FormExecutionRequestReport): string {
  if (typeof response.url !== "string" || response.url.trim() === "") {
    throw new RequestError("Form response requires a final URL", {
      method: report.transportMethod,
      responseStatus: response.status,
    })
  }
  return resolveSameOriginProtocolUrl(response.url, report.requestedUrl, report.requestedUrl, {
    method: report.transportMethod,
    responseStatus: response.status,
  })
}

function requestHeader(request: TurboRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(
    ([candidate]) => candidate.toLowerCase() === name,
  )?.[1]
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
