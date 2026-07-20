import { ContentTypeError, type ExpoTurboError, RequestError } from "./errors"

export const DOCUMENT_LOAD_REQUEST_DISPATCHED = Symbol(
  "expo-turbo.document-load.request-dispatched",
)

export const DOCUMENT_LOAD_DISCARD_HANDLING = Symbol("expo-turbo.document-load.discard-handling")

export const DOCUMENT_BEFORE_SNAPSHOT_CAPTURE = Symbol(
  "expo-turbo.document.before-snapshot-capture",
)

const documentTransportErrors = new WeakSet<Error>()
const documentContentTypeErrors = new WeakSet<ContentTypeError>()

export function createDocumentTransportError(responseStatus?: number): RequestError {
  const error = new RequestError("Document request failed", {
    method: "GET",
    ...(responseStatus !== undefined ? { responseStatus } : {}),
  })
  return markDocumentTransportError(error)
}

export function markDocumentTransportError<ErrorType extends ExpoTurboError>(
  error: ErrorType,
): ErrorType {
  documentTransportErrors.add(error)
  return error
}

export function isDocumentTransportError(error: unknown): error is Error {
  return error instanceof Error && documentTransportErrors.has(error)
}

export function markDocumentContentTypeError<ErrorType extends ContentTypeError>(
  error: ErrorType,
): ErrorType {
  documentContentTypeErrors.add(error)
  return error
}

export function isDocumentContentTypeError(error: unknown): error is ContentTypeError {
  return error instanceof ContentTypeError && documentContentTypeErrors.has(error)
}
