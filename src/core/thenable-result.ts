import { isSessionCommitError } from "./session-commit-error-internal"

type ThenMethod = (
  resolve: (value?: unknown) => void,
  reject: (reason?: unknown) => void,
) => unknown

interface ThenableConsumption {
  fatal: unknown
  remaining: number
  seen: WeakSet<object>
  synchronous: boolean
}

const MAX_THENABLE_CHAIN = 64

/** Reads each possible then method once and consumes a bounded resolution chain. */
export function consumeThenableResult(result: unknown): boolean {
  if (!isObjectLike(result)) return false

  let then: unknown
  try {
    then = (result as { readonly then?: unknown }).then
  } catch (error) {
    if (isSessionCommitError(error)) throw error
    return true
  }
  if (typeof then !== "function") return false

  const consumption: ThenableConsumption = {
    fatal: undefined,
    remaining: MAX_THENABLE_CHAIN,
    seen: new WeakSet(),
    synchronous: true,
  }
  consumeKnownThenable(result, then as ThenMethod, consumption)
  consumption.synchronous = false
  if (consumption.fatal) throw consumption.fatal
  return true
}

function consumeUnknownResult(result: unknown, consumption: ThenableConsumption): void {
  if (!isObjectLike(result) || consumption.remaining === 0 || consumption.seen.has(result)) return

  let then: unknown
  try {
    then = (result as { readonly then?: unknown }).then
  } catch (error) {
    retainSynchronousCommitError(error, consumption)
    return
  }
  if (typeof then !== "function") return
  consumeKnownThenable(result, then as ThenMethod, consumption)
}

function consumeKnownThenable(
  result: object,
  then: ThenMethod,
  consumption: ThenableConsumption,
): void {
  if (consumption.remaining === 0 || consumption.seen.has(result)) return
  consumption.remaining -= 1
  consumption.seen.add(result)

  let settled = false
  try {
    Reflect.apply(then, result, [
      (value?: unknown) => {
        if (settled) return
        settled = true
        consumeUnknownResult(value, consumption)
      },
      (reason?: unknown) => {
        if (settled) return
        settled = true
        retainSynchronousCommitError(reason, consumption)
      },
    ])
  } catch (error) {
    if (!settled) retainSynchronousCommitError(error, consumption)
  }
}

function retainSynchronousCommitError(error: unknown, consumption: ThenableConsumption): void {
  if (consumption.synchronous && !consumption.fatal && isSessionCommitError(error)) {
    consumption.fatal = error
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}
