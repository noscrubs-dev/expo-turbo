const expoTurboErrors = new WeakSet<object>()

export function markExpoTurboError<ErrorType extends object>(error: ErrorType): ErrorType {
  expoTurboErrors.add(error)
  return error
}

export function isExpoTurboError(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    expoTurboErrors.has(error)
  )
}
