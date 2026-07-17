import { describe, expect, test } from "bun:test"

import { EXPO_TURBO_STATUS } from "./index"

describe("package status", () => {
  test("does not claim runtime compatibility", () => {
    expect(EXPO_TURBO_STATUS).toBe("foundation")
  })
})
