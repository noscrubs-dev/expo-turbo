import { isSessionCommitError } from "./session-commit-error-internal.js"

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

/** Resolves one caller-owned thenable through the same bounded hostile-chain rules. */
export function resolveThenableResult(result: unknown): Promise<unknown> | undefined {
  if (!isObjectLike(result)) return undefined
  let then: unknown
  try {
    then = (result as { readonly then?: unknown }).then
  } catch {
    return Promise.reject(new TypeError("Thenable result could not be read"))
  }
  if (typeof then !== "function") return undefined
  return resolveKnownThenable(result, then as ThenMethod, MAX_THENABLE_CHAIN, new WeakSet())
}

function resolveKnownThenable(
  result: object,
  then: ThenMethod,
  remaining: number,
  seen: WeakSet<object>,
): Promise<unknown> {
  if (remaining === 0 || seen.has(result)) {
    return Promise.reject(new TypeError("Thenable result exceeded the bounded resolution chain"))
  }
  seen.add(result)
  return new Promise((resolve, reject) => {
    let settled = false
    try {
      Reflect.apply(then, result, [
        (value?: unknown) => {
          if (settled) return
          settled = true
          const nested = resolveThenableValue(value, remaining - 1, seen)
          if (nested) nested.then(resolve, reject)
          else resolve(value)
        },
        (reason?: unknown) => {
          if (settled) return
          settled = true
          reject(reason)
        },
      ])
    } catch (error) {
      if (!settled) reject(error)
    }
  })
}

function resolveThenableValue(
  value: unknown,
  remaining: number,
  seen: WeakSet<object>,
): Promise<unknown> | undefined {
  if (!isObjectLike(value)) return undefined
  let then: unknown
  try {
    then = (value as { readonly then?: unknown }).then
  } catch {
    return Promise.reject(new TypeError("Thenable result could not be read"))
  }
  if (typeof then !== "function") return undefined
  return resolveKnownThenable(value, then as ThenMethod, remaining, seen)
}

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
