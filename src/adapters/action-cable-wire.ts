import { SubscriptionError } from "../core/errors"

/** The Action Cable subprotocol implemented by the server baseline. */
export const ACTION_CABLE_V1_JSON_PROTOCOL = "actioncable-v1-json" as const

/**
 * Server frames exactly as Action Cable's JSON protocol delivers them.
 * Ordinary channel deliveries intentionally have no `type` field.
 */
export type ActionCableV1Frame =
  | Readonly<{ readonly type: "welcome" }>
  | Readonly<{ readonly type: "ping"; readonly message: number }>
  | Readonly<{
      readonly type: "disconnect"
      readonly reason: string | null
      readonly reconnect: boolean
    }>
  | Readonly<{ readonly type: "confirm_subscription"; readonly identifier: string }>
  | Readonly<{ readonly type: "reject_subscription"; readonly identifier: string }>
  | Readonly<{ readonly identifier: string; readonly message: string }>

function invalidFrame(): SubscriptionError {
  return new SubscriptionError("Action Cable frame is invalid")
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function identifier(value: unknown): string {
  if (typeof value !== "string") throw invalidFrame()
  return value
}

function command(command: "subscribe" | "unsubscribe", value: string): string {
  return JSON.stringify({ command, identifier: identifier(value) })
}

/** Encodes a subscription command without parsing or normalizing its opaque identifier. */
export function encodeActionCableSubscribe(value: string): string {
  return command("subscribe", value)
}

/** Encodes an unsubscription command without parsing or normalizing its opaque identifier. */
export function encodeActionCableUnsubscribe(value: string): string {
  return command("unsubscribe", value)
}

/** Decodes and validates one Action Cable v1 JSON server frame without retaining its raw bytes. */
export function decodeActionCableV1Frame(raw: string): ActionCableV1Frame {
  if (typeof raw !== "string") throw invalidFrame()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalidFrame()
  }
  if (!isObject(parsed)) throw invalidFrame()

  if (parsed.type === undefined) {
    if (typeof parsed.message !== "string") throw invalidFrame()
    return Object.freeze({ identifier: identifier(parsed.identifier), message: parsed.message })
  }

  switch (parsed.type) {
    case "welcome":
      return Object.freeze({ type: "welcome" })
    case "ping": {
      const message = parsed.message
      if (typeof message !== "number" || !Number.isInteger(message)) throw invalidFrame()
      return Object.freeze({ type: "ping", message })
    }
    case "disconnect":
      if (
        (typeof parsed.reason !== "string" && parsed.reason !== null) ||
        typeof parsed.reconnect !== "boolean"
      ) {
        throw invalidFrame()
      }
      return Object.freeze({
        type: "disconnect",
        reason: parsed.reason,
        reconnect: parsed.reconnect,
      })
    case "confirm_subscription":
      return Object.freeze({
        type: "confirm_subscription",
        identifier: identifier(parsed.identifier),
      })
    case "reject_subscription":
      return Object.freeze({
        type: "reject_subscription",
        identifier: identifier(parsed.identifier),
      })
    default:
      throw invalidFrame()
  }
}
