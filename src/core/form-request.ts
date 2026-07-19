import type { TurboRequest, TurboRequestBody } from "../adapters"
import { RequestError, TargetError } from "./errors"
import { admitFormRequestPlan } from "./form-request-plan"
import type { SuccessfulFormEntry } from "./forms"
import { protocolRequestHeaders, resolveSameOriginProtocolUrl } from "./protocol-request"

export const FORM_URL_ENCODED = "application/x-www-form-urlencoded" as const
export const FORM_TEXT_PLAIN = "text/plain" as const
export const FORM_MULTIPART = "multipart/form-data" as const
export const MAX_FORM_REQUEST_ENTRIES = 1_024
export const MAX_FORM_TEXT_PLAIN_BODY_BYTES = 1_048_576

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

function redactedArrayCheck(value: unknown, message: string): boolean {
  try {
    return Array.isArray(value)
  } catch {
    throw new RequestError(message)
  }
}

function requestOption(
  options: BuildFormRequestOptions,
  key: keyof BuildFormRequestOptions,
): unknown {
  try {
    return options[key]
  } catch {
    throw new RequestError("Form request options could not be read")
  }
}

function attributes(
  value: FormRequestAttributes | undefined,
  owner: "form" | "submitter",
): FormRequestAttributes | undefined {
  if (value === undefined && owner === "submitter") return undefined
  if (
    !value ||
    typeof value !== "object" ||
    redactedArrayCheck(value, `Form request ${owner} attributes could not be read`)
  ) {
    throw new RequestError(`Form request ${owner} attributes must be an object`)
  }
  let action: unknown
  let enctype: unknown
  let method: unknown
  let name: unknown
  let streamAttributePresent: unknown
  let submitterValue: unknown
  try {
    action = value.action
    enctype = value.enctype
    method = value.method
    streamAttributePresent = value.streamAttributePresent
    if (owner === "submitter") {
      name = (value as ActivatedFormSubmitter).name
      submitterValue = (value as ActivatedFormSubmitter).value
    }
  } catch {
    throw new RequestError(`Form request ${owner} attributes could not be read`)
  }
  for (const [key, candidate] of [
    ["action", action],
    ["enctype", enctype],
    ["method", method],
  ] as const) {
    if (candidate !== undefined && typeof candidate !== "string") {
      throw new RequestError(`Form request ${owner} ${key} must be a string`)
    }
  }
  if (streamAttributePresent !== undefined && streamAttributePresent !== true) {
    throw new RequestError(`Form request ${owner} Stream marker must represent presence`)
  }
  if (owner === "submitter") {
    for (const [key, candidate] of [
      ["name", name],
      ["value", submitterValue],
    ] as const) {
      if (candidate !== undefined && typeof candidate !== "string") {
        throw new RequestError(`Form request submitter ${key} must be a string`)
      }
    }
  }
  return Object.freeze({
    ...(typeof action === "string" ? { action } : {}),
    ...(typeof enctype === "string" ? { enctype } : {}),
    ...(typeof method === "string" ? { method } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(streamAttributePresent === true ? { streamAttributePresent } : {}),
    ...(typeof submitterValue === "string" ? { value: submitterValue } : {}),
  })
}

function activatedSubmitter(
  value: ActivatedFormSubmitter | undefined,
): ActivatedFormSubmitter | undefined {
  return attributes(value, "submitter") as ActivatedFormSubmitter | undefined
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

function normalizedLineBreaks(
  value: string,
  maximumUtf8Bytes = Number.POSITIVE_INFINITY,
): { readonly utf8Bytes: number; readonly value: string } {
  let normalized = ""
  let utf8Bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    let bytes: number
    let scalar: string
    if (code === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) index += 1
      bytes = 2
      scalar = "\r\n"
    } else if (code === 0x0a) {
      bytes = 2
      scalar = "\r\n"
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4
        scalar = value.slice(index, index + 2)
        index += 1
      } else {
        bytes = 3
        scalar = "\ufffd"
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes = 3
      scalar = "\ufffd"
    } else {
      bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
      scalar = value.charAt(index)
    }
    utf8Bytes += bytes
    if (utf8Bytes > maximumUtf8Bytes) {
      throw new RequestError("Text form request body limit exceeded")
    }
    normalized += scalar
  }
  return Object.freeze({ utf8Bytes, value: normalized })
}

function admittedEntries(
  entries: readonly SuccessfulFormEntry[],
  maximumTextPlainBodyBytes?: number,
): readonly SuccessfulFormEntry[] {
  if (redactedArrayCheck(entries, "Form request entries could not be read") !== true) {
    throw new RequestError("Form request entries must be an array")
  }
  let length: unknown
  try {
    length = entries.length
  } catch {
    throw new RequestError("Form request entries could not be read")
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new RequestError("Form request entries must be an array")
  }
  if (length > MAX_FORM_REQUEST_ENTRIES) {
    throw new RequestError("Form request entry limit exceeded")
  }
  const admitted: SuccessfulFormEntry[] = []
  let textPlainBodyBytes = 0
  for (let index = 0; index < length; index += 1) {
    let entry: unknown
    let ownsEntry: boolean
    try {
      ownsEntry = Object.hasOwn(entries, index)
      if (ownsEntry) entry = entries[index]
    } catch {
      throw new RequestError("Form request entries could not be read")
    }
    if (!ownsEntry) {
      throw new RequestError("Form request entries must contain string names and values")
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      redactedArrayCheck(entry, "Form request entry could not be read")
    ) {
      throw new RequestError("Form request entries must contain string names and values")
    }
    let name: unknown
    let value: unknown
    try {
      name = (entry as SuccessfulFormEntry).name
      value = (entry as SuccessfulFormEntry).value
    } catch {
      throw new RequestError("Form request entry could not be read")
    }
    if (typeof name !== "string" || typeof value !== "string") {
      throw new RequestError("Form request entries must contain string names and values")
    }
    const availableBytes =
      maximumTextPlainBodyBytes === undefined
        ? Number.POSITIVE_INFINITY
        : maximumTextPlainBodyBytes - textPlainBodyBytes - 3
    if (availableBytes < 0) {
      throw new RequestError("Text form request body limit exceeded")
    }
    const admittedName = normalizedLineBreaks(name, availableBytes)
    const admittedValue = normalizedLineBreaks(value, availableBytes - admittedName.utf8Bytes)
    textPlainBodyBytes += admittedName.utf8Bytes + admittedValue.utf8Bytes + 3
    admitted.push(
      Object.freeze({
        name: admittedName.value,
        value: admittedValue.value,
      }),
    )
  }
  return Object.freeze(admitted)
}

function validateSubmitterEntry(
  submitter: ActivatedFormSubmitter | undefined,
  entries: readonly SuccessfulFormEntry[],
  maximumTextPlainBodyBytes?: number,
): void {
  if (!submitter?.name) return
  const entry = entries.at(-1)
  const availableBytes =
    maximumTextPlainBodyBytes === undefined
      ? Number.POSITIVE_INFINITY
      : maximumTextPlainBodyBytes - 3
  const name = normalizedLineBreaks(submitter.name, availableBytes)
  const value = normalizedLineBreaks(submitter.value ?? "", availableBytes - name.utf8Bytes)
  if (!entry || entry.name !== name.value || entry.value !== value.value) {
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

function utf8ByteLength(value: string): number {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      length += 1
    } else if (code <= 0x7ff) {
      length += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      length += 4
      index += 1
    } else {
      length += 3
    }
  }
  return length
}

function textPlainBody(entries: readonly SuccessfulFormEntry[]): TurboRequestBody {
  const records: string[] = []
  let bytes = 0
  for (const entry of entries) {
    bytes += utf8ByteLength(entry.name) + utf8ByteLength(entry.value) + 3
    if (bytes > MAX_FORM_TEXT_PLAIN_BODY_BYTES) {
      throw new RequestError("Text form request body limit exceeded")
    }
    records.push(`${entry.name}=${entry.value}\r\n`)
  }
  return Object.freeze({
    contentType: FORM_TEXT_PLAIN,
    value: records.join(""),
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

function protocolOptions(value: unknown): FormRequestProtocolOptions {
  if (
    !value ||
    typeof value !== "object" ||
    redactedArrayCheck(value, "Form request protocol metadata could not be read")
  ) {
    throw new RequestError("Form request protocol metadata is invalid")
  }
  let capabilityHash: unknown
  let frameId: unknown
  let requestId: unknown
  try {
    capabilityHash = (value as FormRequestProtocolOptions).capabilityHash
    frameId = (value as FormRequestProtocolOptions).frameId
    requestId = (value as FormRequestProtocolOptions).requestId
  } catch {
    throw new RequestError("Form request protocol metadata could not be read")
  }
  if (
    typeof requestId !== "string" ||
    (capabilityHash !== undefined && typeof capabilityHash !== "string") ||
    (frameId !== undefined && typeof frameId !== "string")
  ) {
    throw new RequestError("Form request protocol metadata is invalid")
  }
  return Object.freeze({
    ...(typeof capabilityHash === "string" ? { capabilityHash } : {}),
    ...(typeof frameId === "string" ? { frameId } : {}),
    requestId,
  })
}

/**
 * Builds one immutable transport plan from raw form/submitter attributes and
 * successful string entries. Fetch ownership, multipart uploads, constraint
 * validation, pending UI, and response handling remain separate session work.
 */
export function buildFormRequest(options: BuildFormRequestOptions): FormRequestPlan {
  if (
    !options ||
    typeof options !== "object" ||
    redactedArrayCheck(options, "Form request options could not be read")
  ) {
    throw new RequestError("Form request options must be an object")
  }
  const documentUrl = requestOption(options, "documentUrl")
  if (typeof documentUrl !== "string") {
    throw new RequestError("Form request document URL must be a string")
  }
  const form = attributes(
    requestOption(options, "form") as FormRequestAttributes,
    "form",
  ) as FormRequestAttributes
  const submitter = activatedSubmitter(
    requestOption(options, "submitter") as ActivatedFormSubmitter | undefined,
  )

  const source = sourceMethod(form, submitter)
  const encoding = canonicalEncoding(form, submitter)
  const action = submitter?.action !== undefined ? submitter.action : (form.action ?? "")
  const resolvedUrl = resolveSameOriginProtocolUrl(action, documentUrl, documentUrl, {
    method: source,
  })
  if (resolvedUrl.includes("#")) {
    throw new TargetError("Form request fragments require navigation support", { method: source })
  }
  const url = new URL(resolvedUrl)

  const protocol = protocolOptions(requestOption(options, "protocol"))
  const signal = requestSignal(requestOption(options, "signal"))
  const unsafeTransport = unsafeMethodTransport(requestOption(options, "unsafeMethodTransport"))
  const maximumTextPlainBodyBytes =
    source !== "GET" && encoding === FORM_TEXT_PLAIN ? MAX_FORM_TEXT_PLAIN_BODY_BYTES : undefined
  const admitted = admittedEntries(
    requestOption(options, "entries") as readonly SuccessfulFormEntry[],
    maximumTextPlainBodyBytes,
  )
  validateSubmitterEntry(submitter, admitted, maximumTextPlainBodyBytes)
  const effective =
    unsafeTransport === "direct" ? source : effectiveMethod(source, admitted, submitter)
  let requestEntries = admitted
  if (source !== "GET" && unsafeTransport === "rails") {
    if (effective === "GET") {
      throw new RequestError("Unsafe form requests require an unsafe effective method", {
        method: source,
      })
    }
    requestEntries = railsEntries(admitted, effective)
    if (requestEntries.length > MAX_FORM_REQUEST_ENTRIES) {
      throw new RequestError("Form request entry limit exceeded")
    }
  }
  const headers = protocolRequestHeaders({
    acceptsTurboStream:
      source !== "GET" ||
      form.streamAttributePresent === true ||
      submitter?.streamAttributePresent === true,
    ...(protocol.capabilityHash !== undefined ? { capabilityHash: protocol.capabilityHash } : {}),
    ...(protocol.frameId !== undefined ? { frameId: protocol.frameId } : {}),
    requestId: protocol.requestId,
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
    if (encoding === FORM_TEXT_PLAIN && unsafeTransport === "rails" && effective !== "POST") {
      throw new RequestError("Text form method overrides require URL-encoded or multipart data", {
        method: effective,
      })
    }
    const body =
      encoding === FORM_TEXT_PLAIN ? textPlainBody(requestEntries) : urlEncodedBody(requestEntries)
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
