import { SubscriptionError } from "../core/errors.js"

function endpointError(): SubscriptionError {
  return new SubscriptionError("Action Cable endpoint is invalid")
}

function isCleanString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value !== "" &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return (
        character === "\\" ||
        character === "?" ||
        character === "#" ||
        (codePoint !== undefined && (codePoint <= 31 || codePoint === 127))
      )
    })
  )
}

function isRootOriginSyntax(value: string): boolean {
  return /^https?:\/\/[^/?#]+\/?$/i.test(value)
}

function parseOrigin(value: string): URL {
  if (!isCleanString(value) || !isRootOriginSyntax(value)) throw endpointError()

  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw endpointError()
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.hostname === "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw endpointError()
  }
  return origin
}

/**
 * Resolves a host-declared Action Cable mount path against one credential-free
 * HTTP(S) origin. It creates no socket and deliberately cannot carry tickets
 * or headers; those remain an explicit host authentication decision.
 */
export function resolveActionCableEndpoint(origin: string, mountPath: string): string {
  const base = parseOrigin(origin)
  if (!isCleanString(mountPath) || !mountPath.startsWith("/") || mountPath.startsWith("//")) {
    throw endpointError()
  }

  let endpoint: URL
  try {
    endpoint = new URL(mountPath, base)
  } catch {
    throw endpointError()
  }
  if (
    endpoint.origin !== base.origin ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== mountPath ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw endpointError()
  }

  endpoint.protocol = base.protocol === "https:" ? "wss:" : "ws:"
  return endpoint.toString()
}
