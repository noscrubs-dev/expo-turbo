const committedErrors = new WeakSet<object>()

export function markSessionCommitError<ErrorType extends object>(error: ErrorType): ErrorType {
  committedErrors.add(error)
  return error
}

export function isSessionCommitError(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    committedErrors.has(error)
  )
}
