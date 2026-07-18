import { describe, expect, test } from "bun:test"

import { RequestError } from "./errors"
import { RECENT_REQUEST_ID_LIMIT, RecentRequestIds } from "./recent-request-ids"

describe("recent request ids", () => {
  test("retains only the newest twenty request ids in insertion order", () => {
    const requests = new RecentRequestIds()

    for (let index = 1; index <= RECENT_REQUEST_ID_LIMIT + 2; index += 1) {
      requests.add(`request-${index}`)
    }

    expect(requests.has("request-1")).toBe(false)
    expect(requests.has("request-2")).toBe(false)
    expect(requests.has("request-3")).toBe(true)
    expect(requests.has(`request-${RECENT_REQUEST_ID_LIMIT + 2}`)).toBe(true)
  })

  test("validates its bound and admitted ids", () => {
    expect(() => new RecentRequestIds(0)).toThrow(RequestError)
    expect(() => new RecentRequestIds(1.5)).toThrow(RequestError)

    const requests = new RecentRequestIds(2)
    expect(() => requests.add("")).toThrow(RequestError)
    expect(() => requests.add("   ")).toThrow(RequestError)
    expect(requests.has(undefined)).toBe(false)
  })
})
