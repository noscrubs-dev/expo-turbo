import type { TurboRequest, TurboRequestBody } from "../adapters"
import { RequestError, TargetError } from "./errors"
import { admitFormRequestPlan } from "./form-request-plan"
import type { SuccessfulFormEntry } from "./forms"
import { protocolRequestHeaders, resolveSameOriginProtocolUrl } from "./protocol-request"

export const FORM_URL_ENCODED = "application/x-www-form-urlencoded" as const
export const FORM_TEXT_PLAIN = "text/plain" as const
export const FORM_MULTIPART = "multipart/form-data" as const

export type FormSubmissionEncoding =
  | typeof FORM_MULTIPART
  | typeof FORM_TEXT_PLAIN
  | typeof FORM_URL_ENCODED

export type FormSubmissionMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT"

/**
 * Registered Rails forms use POST plus `_method`; Turbo-generated form links
 * use the authored unsafe HTTP verb directly and keep `_method` as ordinary
 * ordered form data.
 */
export type UnsafeFormMethodTransport = "direct" | "rails"

export interface FormRequestAttributes {
  readonly action?: string
  readonly enctype?: string
  readonly method?: string
  /** Attribute presence is meaningful; its textual XML value is not. */
  readonly streamAttributePresent?: true
}

export interface ActivatedFormSubmitter extends FormRequestAttributes {
  readonly name?: string
  readonly value?: string
}

export interface FormRequestProtocolOptions {
  readonly capabilityHash?: string
  readonly frameId?: string
  readonly requestId: string
}

export interface BuildFormRequestOptions {
  readonly documentUrl: string
  readonly entries: readonly SuccessfulFormEntry[]
  readonly form: FormRequestAttributes
  readonly protocol: FormRequestProtocolOptions
  readonly signal?: AbortSignal
  readonly submitter?: ActivatedFormSubmitter
  readonly unsafeMethodTransport?: UnsafeFormMethodTransport
}

declare const FORM_REQUEST_PLAN: unique symbol

export interface FormRequestPlan {
  readonly [FORM_REQUEST_PLAN]: true
  readonly effectiveMethod: FormSubmissionMethod
  readonly encoding: FormSubmissionEncoding
  readonly entries: readonly SuccessfulFormEntry[]
  readonly request: TurboRequest
  readonly sourceMethod: FormSubmissionMethod
}

const METHODS = new Set<FormSubmissionMethod>(["DELETE", "GET", "PATCH", "POST", "PUT"])
const ENCODINGS = new Set<FormSubmissionEncoding>([
  FORM_MULTIPART,
  FORM_TEXT_PLAIN,
  FORM_URL_ENCODED,
])

function attributes(
  value: FormRequestAttributes | undefined,
  owner: "form" | "submitter",
): FormRequestAttributes | undefined {
  if (value === undefined && owner === "submitter") return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(`Form request ${owner} attributes must be an object`)
  }
  for (const key of ["action", "enctype", "method"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new RequestError(`Form request ${owner} ${key} must be a string`)
    }
  }
  if (value.streamAttributePresent !== undefined && value.streamAttributePresent !== true) {
    throw new RequestError(`Form request ${owner} Stream marker must represent presence`)
  }
  return value
}

function activatedSubmitter(
  value: ActivatedFormSubmitter | undefined,
): ActivatedFormSubmitter | undefined {
  const admitted = attributes(value, "submitter") as ActivatedFormSubmitter | undefined
  if (!admitted) return undefined
  for (const key of ["name", "value"] as const) {
    if (admitted[key] !== undefined && typeof admitted[key] !== "string") {
      throw new RequestError(`Form request submitter ${key} must be a string`)
    }
  }
  return admitted
}

function nonEmpty(primary: string | undefined, fallback?: string): string | undefined {
  if (primary !== undefined && primary !== "") return primary
  if (fallback !== undefined && fallback !== "") return fallback
  return undefined
}

function canonicalMethod(value: string | undefined): FormSubmissionMethod | undefined {
  if (value === undefined) return undefined
  const candidate = value.toUpperCase() as FormSubmissionMethod
  return METHODS.has(candidate) ? candidate : undefined
}

function sourceMethod(
  form: FormRequestAttributes,
  submitter: ActivatedFormSubmitter | undefined,
): FormSubmissionMethod {
  return canonicalMethod(nonEmpty(submitter?.method, form.method)) ?? "GET"
}

function canonicalEncoding(
  form: FormRequestAttributes,
  submitter: ActivatedFormSubmitter | undefined,
): FormSubmissionEncoding {
  const candidate = nonEmpty(submitter?.enctype, form.enctype)?.toLowerCase()
  return candidate && ENCODINGS.has(candidate as FormSubmissionEncoding)
    ? (candidate as FormSubmissionEncoding)
    : FORM_URL_ENCODED
}

function normalizedLineBreaks(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n")
}

function admittedEntries(entries: readonly SuccessfulFormEntry[]): readonly SuccessfulFormEntry[] {
  if (!Array.isArray(entries)) {
    throw new RequestError("Form request entries must be an array")
  }
  const admitted: SuccessfulFormEntry[] = []
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.name !== "string" ||
      entry.name === "" ||
      typeof entry.value !== "string"
    ) {
      throw new RequestError("Form request entries must contain string names and values")
    }
    admitted.push(
      Object.freeze({
        name: normalizedLineBreaks(entry.name),
        value: normalizedLineBreaks(entry.value),
      }),
    )
  }
  return Object.freeze(admitted)
}

function validateSubmitterEntry(
  submitter: ActivatedFormSubmitter | undefined,
  entries: readonly SuccessfulFormEntry[],
): void {
  if (!submitter?.name) return
  const entry = entries.at(-1)
  if (
    !entry ||
    entry.name !== normalizedLineBreaks(submitter.name) ||
    entry.value !== normalizedLineBreaks(submitter.value ?? "")
  ) {
    throw new RequestError("Activated named submitter must match the final successful entry")
  }
}

function effectiveMethod(
  source: FormSubmissionMethod,
  entries: readonly SuccessfulFormEntry[],
  submitter: ActivatedFormSubmitter | undefined,
): FormSubmissionMethod {
  if (source === "GET") return source

  let candidate: string | undefined
  if (submitter?.name === "_method") {
    candidate = submitter.value ?? ""
  } else if (submitter?.method !== undefined && submitter.method !== "") {
    candidate = submitter.method
  } else {
    const entry = entries.find((item) => item.name === "_method")
    candidate = entry ? entry.value : source
  }

  const method = canonicalMethod(candidate)
  if (!method || method === "GET") {
    throw new RequestError("Rails form method override must be POST, PUT, PATCH, or DELETE", {
      method: source,
    })
  }
  return method
}

function railsEntries(
  entries: readonly SuccessfulFormEntry[],
  method: Exclude<FormSubmissionMethod, "GET">,
): readonly SuccessfulFormEntry[] {
  if (method === "POST") return Object.freeze(entries.filter((entry) => entry.name !== "_method"))

  const value = method.toLowerCase()
  const normalized: SuccessfulFormEntry[] = []
  let replaced = false
  for (const entry of entries) {
    if (entry.name !== "_method") {
      normalized.push(entry)
    } else if (!replaced) {
      normalized.push(Object.freeze({ name: "_method", value }))
      replaced = true
    }
  }
  if (!replaced) normalized.push(Object.freeze({ name: "_method", value }))
  return Object.freeze(normalized)
}

function urlEncodedBody(entries: readonly SuccessfulFormEntry[]): TurboRequestBody {
  const parameters = new URLSearchParams()
  for (const entry of entries) parameters.append(entry.name, entry.value)
  return Object.freeze({
    contentType: `${FORM_URL_ENCODED};charset=UTF-8`,
    value: parameters.toString(),
  })
}

function requestSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  try {
    const candidate = value as Partial<AbortSignal>
    if (
      !value ||
      typeof value !== "object" ||
      typeof candidate.aborted !== "boolean" ||
      typeof candidate.addEventListener !== "function" ||
      typeof candidate.removeEventListener !== "function" ||
      typeof candidate.dispatchEvent !== "function" ||
      !("onabort" in value) ||
      (candidate.onabort !== null && typeof candidate.onabort !== "function")
    ) {
      throw new Error("invalid signal")
    }
  } catch {
    throw new RequestError("Form request signal must be an AbortSignal")
  }
  return value as AbortSignal
}

function unsafeMethodTransport(value: unknown): UnsafeFormMethodTransport {
  if (value === undefined || value === "rails") return "rails"
  if (value === "direct") return value
  throw new RequestError("Form request unsafe method transport is unsupported")
}

/**
 * Builds one immutable transport plan from raw form/submitter attributes and
 * successful string entries. Fetch ownership, multipart uploads, constraint
 * validation, pending UI, and response handling remain separate session work.
 */
export function buildFormRequest(options: BuildFormRequestOptions): FormRequestPlan {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new RequestError("Form request options must be an object")
  }
  if (typeof options.documentUrl !== "string") {
    throw new RequestError("Form request document URL must be a string")
  }
  const form = attributes(options.form, "form") as FormRequestAttributes
  const submitter = activatedSubmitter(options.submitter)
  const signal = requestSignal(options.signal)
  const unsafeTransport = unsafeMethodTransport(options.unsafeMethodTransport)
  if (
    !options.protocol ||
    typeof options.protocol !== "object" ||
    Array.isArray(options.protocol) ||
    typeof options.protocol.requestId !== "string" ||
    (options.protocol.capabilityHash !== undefined &&
      typeof options.protocol.capabilityHash !== "string") ||
    (options.protocol.frameId !== undefined && typeof options.protocol.frameId !== "string")
  ) {
    throw new RequestError("Form request protocol metadata is invalid")
  }

  const source = sourceMethod(form, submitter)
  const action = submitter?.action !== undefined ? submitter.action : (form.action ?? "")
  const resolvedUrl = resolveSameOriginProtocolUrl(
    action,
    options.documentUrl,
    options.documentUrl,
    {
      method: source,
    },
  )
  if (resolvedUrl.includes("#")) {
    throw new TargetError("Form request fragments require navigation support", { method: source })
  }
  const url = new URL(resolvedUrl)

  const admitted = admittedEntries(options.entries)
  validateSubmitterEntry(submitter, admitted)
  const effective =
    unsafeTransport === "direct" ? source : effectiveMethod(source, admitted, submitter)
  const encoding = canonicalEncoding(form, submitter)
  let requestEntries = admitted
  if (source !== "GET" && unsafeTransport === "rails") {
    if (effective === "GET") {
      throw new RequestError("Unsafe form requests require an unsafe effective method", {
        method: source,
      })
    }
    requestEntries = railsEntries(admitted, effective)
  }
  const headers = protocolRequestHeaders({
    acceptsTurboStream:
      source !== "GET" ||
      form.streamAttributePresent === true ||
      submitter?.streamAttributePresent === true,
    ...(options.protocol.capabilityHash !== undefined
      ? { capabilityHash: options.protocol.capabilityHash }
      : {}),
    ...(options.protocol.frameId !== undefined ? { frameId: options.protocol.frameId } : {}),
    requestId: options.protocol.requestId,
  })

  let request: TurboRequest
  if (source === "GET") {
    url.search = ""
    for (const entry of requestEntries) url.searchParams.append(entry.name, entry.value)
    request = Object.freeze({
      headers,
      method: source,
      ...(signal ? { signal } : {}),
      url: url.toString(),
    })
  } else {
    if (encoding === FORM_MULTIPART) {
      throw new RequestError("Multipart form requests require an upload adapter", {
        method: effective,
      })
    }
    if (encoding === FORM_TEXT_PLAIN) {
      throw new RequestError("Text form requests require a matching Rails decoder", {
        method: effective,
      })
    }
    const body = urlEncodedBody(requestEntries)
    request = Object.freeze({
      body,
      headers,
      method: unsafeTransport === "direct" ? source : "POST",
      ...(signal ? { signal } : {}),
      url: url.toString(),
    })
  }

  const plan = Object.freeze({
    effectiveMethod: effective,
    encoding,
    entries: requestEntries,
    request,
    sourceMethod: source,
  }) as FormRequestPlan
  return admitFormRequestPlan(plan)
}
