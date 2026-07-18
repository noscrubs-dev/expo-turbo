import { describe, expect, test } from "bun:test"

import { TargetError } from "./errors"
import { resolveDocumentLinkUrl } from "./protocol-request"

describe("document link URL admission", () => {
  test("admits normalized mail and telephone schemes without weakening protocol URLs", () => {
    expect(
      resolveDocumentLinkUrl(
        "MAILTO:help@example.com?subject=Hello%23World&body=One%0D%0ATwo",
        "https://example.test/gallery",
      ),
    ).toEqual({
      kind: "external",
      scheme: "mailto",
      url: "mailto:help@example.com?subject=Hello%23World&body=One%0D%0ATwo",
    })
    expect(
      resolveDocumentLinkUrl("tel:+15551234567;ext=9", "https://example.test/gallery"),
    ).toEqual({
      kind: "external",
      scheme: "tel",
      url: "tel:+15551234567;ext=9",
    })
    expect(resolveDocumentLinkUrl("../next", "https://example.test/current/gallery")).toEqual({
      kind: "protocol",
      resolution: {
        documentOrigin: "https://example.test",
        url: "https://example.test/next",
        urlOrigin: "https://example.test",
      },
    })
  })

  test("rejects fragments, raw controls, credentials, malformed URLs, and every other scheme", () => {
    const sources = [
      "mailto:help@example.com#fragment",
      "tel:+15551234567#",
      "mailto:help@example.com\n?subject=secret-token",
      "mailto://user:secret-token@example.com/path",
      "tel://user:secret-token@example.com/path",
      "mailto://example.com/path",
      "mailto:///path",
      "mailto:////example.com/path",
      "tel://example.com/+15551234567",
      "tel:///+15551234567",
      "tel:////+15551234567",
      "tel:",
      "mailto:help@example.com\u0000?subject=secret-token",
      "mailto:help@example.com\t?subject=secret-token",
      "mailto:help@example.com\r?subject=secret-token",
      "mailto:help@example.com\u007f?subject=secret-token",
      "javascript:secret-token",
      "data:text/plain,secret-token",
      "file:///secret-token",
      "blob:https://example.test/secret-token",
      "sms:+15551234567",
      "custom:secret-token",
      "https://user:secret-token@outside.test/path",
      "http://[secret-token",
      "",
    ]

    for (const source of sources) {
      let error: unknown
      try {
        resolveDocumentLinkUrl(source, "https://example.test/gallery", { target: "link" })
      } catch (reason) {
        error = reason
      }
      expect(error).toBeInstanceOf(TargetError)
      if (!(error instanceof TargetError)) throw new Error("fixture URL did not reject")
      expect(error.cause).toBeUndefined()
      expect(error.message).not.toContain("secret-token")
      expect(JSON.stringify(error.context)).not.toContain("secret-token")
    }
  })

  test("requires a credential-free HTTP(S) active document even for external schemes", () => {
    for (const documentUrl of [
      "file:///gallery",
      "https://user:secret-token@example.test/gallery",
      "not a URL",
    ]) {
      expect(() => resolveDocumentLinkUrl("mailto:help@example.com", documentUrl)).toThrow(
        TargetError,
      )
    }
  })
})
