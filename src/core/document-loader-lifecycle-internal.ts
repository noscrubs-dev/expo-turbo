import { ContentTypeError, type ExpoTurboError, RequestError } from "./errors"

export const DOCUMENT_LOAD_REQUEST_DISPATCHED = Symbol(
  "expo-turbo.document-load.request-dispatched",
)

export const DOCUMENT_LOAD_DISCARD_HANDLING = Symbol("expo-turbo.document-load.discard-handling")

export const DOCUMENT_LOAD_PREFETCHED_RESPONSE = Symbol(
  "expo-turbo.document-load.prefetched-response",
)

export const DOCUMENT_BEFORE_SNAPSHOT_CAPTURE = Symbol(
  "expo-turbo.document.before-snapshot-capture",
)

const documentTransportErrors = new WeakSet<Error>()
const documentTransportErrorUrls = new WeakMap<Error, string>()
const documentContentTypeErrors = new WeakSet<ContentTypeError>()
const documentContentTypeErrorResponses = new WeakMap<
  ContentTypeError,
  Readonly<{
    classification: "client-error" | "server-error" | "success"
    redirected: boolean
    responseStatus: number
    url: string
  }>
>()

export function createDocumentTransportError(responseStatus?: number, url?: string): RequestError {
  const error = new RequestError("Document request failed", {
    method: "GET",
    ...(responseStatus !== undefined ? { responseStatus } : {}),
  })
  return markDocumentTransportError(error, url)
}

export function markDocumentTransportError<ErrorType extends ExpoTurboError>(
  error: ErrorType,
  url?: string,
): ErrorType {
  documentTransportErrors.add(error)
  if (url) documentTransportErrorUrls.set(error, url)
  return error
}

export function isDocumentTransportError(error: unknown): error is Error {
  return error instanceof Error && documentTransportErrors.has(error)
}

export function documentTransportErrorUrl(error: unknown): string | undefined {
  return error instanceof Error ? documentTransportErrorUrls.get(error) : undefined
}

export function markDocumentContentTypeError<ErrorType extends ContentTypeError>(
  error: ErrorType,
  response?: Readonly<{
    classification: "client-error" | "server-error" | "success"
    redirected: boolean
    responseStatus: number
    url: string
  }>,
): ErrorType {
  documentContentTypeErrors.add(error)
  if (response) documentContentTypeErrorResponses.set(error, Object.freeze(response))
  return error
}

export function isDocumentContentTypeError(error: unknown): error is ContentTypeError {
  return error instanceof ContentTypeError && documentContentTypeErrors.has(error)
}

export function documentContentTypeErrorResponse(error: unknown) {
  return error instanceof ContentTypeError
    ? documentContentTypeErrorResponses.get(error)
    : undefined
}
