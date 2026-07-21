import { PropsError } from "./errors"
import { attributeValue, type ProtocolElement } from "./tree"

export type ProtocolDirection = "auto" | "ltr" | "rtl"

export function protocolDirection(element: ProtocolElement): ProtocolDirection | undefined {
  const direction = attributeValue(element, "dir")
  if (direction === undefined || direction === "") return undefined
  if (direction === "auto" || direction === "ltr" || direction === "rtl") return direction
  throw new PropsError(`Invalid shared dir attribute on ${JSON.stringify(element.tagName)}`, {
    target: element.tagName,
  })
}
