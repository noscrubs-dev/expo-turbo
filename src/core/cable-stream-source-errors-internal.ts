const reportedCableStreamSourceErrors = new WeakSet<Error>()

export function markCableStreamSourceErrorReported(error: Error): void {
  reportedCableStreamSourceErrors.add(error)
}

export function wasCableStreamSourceErrorReported(error: Error): boolean {
  return reportedCableStreamSourceErrors.has(error)
}
