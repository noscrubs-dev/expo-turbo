import { expect, test } from "bun:test"

import { sha256Hex } from "./sha256-internal"

test("pure TypeScript SHA-256 matches fixed UTF-8 vectors", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(sha256Hex("Expo Turbo 😀")).toBe(
    "0033643a7c2c130f4402e4b55f9029a12df5a31014bdbeb0962fad5b32e5ea6b",
  )
})
